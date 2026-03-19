const express = require('express')
const cors = require('cors')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const app = express()
const port = 3000
const host = '0.0.0.0'

app.use(cors({
    origin(origin, callback) {
        if (!origin) {
            callback(null, true)
            return
        }

        const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.100\.97)(:\d+)?$/

        if (allowedOriginPattern.test(origin)) {
            callback(null, true)
            return
        }

        callback(new Error('Not allowed by CORS: ' + origin))
    }
}))
app.use(express.json())

const jobs = new Map()
const JOB_TTL_MS = 5 * 60 * 1000

const YT_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be'
])

function isValidYouTubeUrl(value) {
    try {
        const parsed = new URL(value)
        return YT_HOSTS.has(parsed.hostname.toLowerCase())
    } catch {
        return false
    }
}

function downloadWithYtDlp(url, outputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '--no-warnings',
            '--no-playlist',
            '--newline',
            '--merge-output-format',
            'mp4',
            '-f',
            'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
            '-o',
            outputPath,
            url
        ]

        const child = spawn('yt-dlp', args, { windowsHide: true })
        let stderr = ''

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString()
        })

        child.on('error', (error) => {
            reject(error)
        })

        child.on('close', (code) => {
            if (code === 0) {
                resolve()
                return
            }

            reject(new Error(stderr || `yt-dlp failed with exit code ${code}`))
        })
    })
}

function parsePercent(text) {
    const match = text.match(/(\d+(?:\.\d+)?)%/)
    if (!match) {
        return null
    }

    const value = Number.parseFloat(match[1])
    if (!Number.isFinite(value)) {
        return null
    }

    return Math.max(0, Math.min(100, value))
}

function createJob(url) {
    const id = crypto.randomUUID()
    const filePath = path.join(os.tmpdir(), `yt-download-${id}.mp4`)

    const job = {
        id,
        url,
        filePath,
        fileName: `video-${id}.mp4`,
        status: 'queued',
        serverProgress: 0,
        error: null,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        cleanupAt: null,
        cleanupTimer: null
    }

    jobs.set(id, job)
    return job
}

async function cleanupJob(job) {
    if (job.cleanupTimer) {
        clearTimeout(job.cleanupTimer)
        job.cleanupTimer = null
    }

    try {
        await fsp.unlink(job.filePath)
    } catch {
        // Ignore missing file and cleanup errors.
    }

    jobs.delete(job.id)
}

function scheduleJobCleanup(job, delayMs = JOB_TTL_MS) {
    if (job.cleanupTimer) {
        clearTimeout(job.cleanupTimer)
    }

    job.cleanupAt = Date.now() + delayMs
    job.cleanupTimer = setTimeout(() => {
        cleanupJob(job)
    }, delayMs)
    job.cleanupTimer.unref?.()
}

function touchJob(job) {
    job.lastAccessedAt = Date.now()
    scheduleJobCleanup(job)
}

function startJob(job) {
    job.status = 'downloading'

    const args = [
        '--no-warnings',
        '--no-playlist',
        '--newline',
        '--merge-output-format',
        'mp4',
        '-f',
        'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '-o',
        job.filePath,
        job.url
    ]

    const child = spawn('yt-dlp', args, { windowsHide: true })

    let phaseDetected = false // Track when we detect phase 2

    const onChunk = (chunk) => {
        const text = chunk.toString()
        const percent = parsePercent(text)

        if (percent !== null) {
            let scaledProgress = percent

            // Detect phase 2 (when progress resets/decreases)
            if (percent < job.serverProgress) {
                phaseDetected = true
            }

            if (!phaseDetected) {
                // Phase 1: scale 0-100 to 0-50
                scaledProgress = (percent / 100) * 50
            } else {
                // Phase 2: scale 0-100 to 50-100
                scaledProgress = 50 + (percent / 100) * 50
            }

            job.serverProgress = Math.round(scaledProgress)
            console.log(`[Job ${job.id}] Progress: ${job.serverProgress}% (raw: ${percent}%, phase: ${phaseDetected ? 2 : 1})`)
        }
    }

    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    child.on('error', (error) => {
        job.status = 'failed'
        job.error = error?.code === 'ENOENT'
            ? 'yt-dlp is not installed. Install yt-dlp and make sure it is in PATH.'
            : String(error.message || error)
        scheduleJobCleanup(job)
    })

    child.on('close', async (code) => {
        if (code === 0) {
            job.serverProgress = 100
            job.status = 'ready'
            console.log(`[Job ${job.id}] Download complete!`)
            scheduleJobCleanup(job)
            return
        }

        job.status = 'failed'
        job.error = `yt-dlp failed with exit code ${code}`

        try {
            await fsp.unlink(job.filePath)
        } catch {
            // Ignore cleanup errors.
        }

        scheduleJobCleanup(job)
    })
}

async function handleDownload(req, res) {
    const rawUrl = req.method === 'GET' ? req.query.url : req.body?.url

    if (!rawUrl || typeof rawUrl !== 'string') {
        res.status(400).json({ error: 'Missing required url field' })
        return
    }

    if (!isValidYouTubeUrl(rawUrl)) {
        res.status(400).json({ error: 'Invalid YouTube URL' })
        return
    }

    const fileId = crypto.randomUUID()
    const filePath = path.join(os.tmpdir(), `yt-download-${fileId}.mp4`)

    try {
        await downloadWithYtDlp(rawUrl, filePath)

        await fsp.access(filePath, fs.constants.R_OK)

        res.download(filePath, `video-${fileId}.mp4`, async () => {
            try {
                await fsp.unlink(filePath)
            } catch {
                // Ignore cleanup errors.
            }
        })
    } catch (error) {
        try {
            await fsp.unlink(filePath)
        } catch {
            // Ignore cleanup errors.
        }

        if (error?.code === 'ENOENT') {
            res.status(500).json({
                error: 'yt-dlp is not installed. Install yt-dlp and make sure it is in PATH.'
            })
            return
        }

        res.status(500).json({ error: 'Download failed', detail: String(error.message || error) })
    }
}

app.post('/download/start', (req, res) => {
    const rawUrl = req.body?.url

    if (!rawUrl || typeof rawUrl !== 'string') {
        res.status(400).json({ error: 'Missing required url field' })
        return
    }

    if (!isValidYouTubeUrl(rawUrl)) {
        res.status(400).json({ error: 'Invalid YouTube URL' })
        return
    }

    const job = createJob(rawUrl)
    console.log(`[Job ${job.id}] Created, starting download...`)
    startJob(job)

    res.status(202).json({
        jobId: job.id,
        status: job.status,
        serverProgress: job.serverProgress,
        fileName: job.fileName,
        downloadPath: `/download/file/${job.id}`,
        expiresInMs: JOB_TTL_MS
    })
})

app.get('/download/progress/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId)

    if (!job) {
        res.status(404).json({ error: 'Job not found' })
        return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = () => {
        res.write(`data: ${JSON.stringify({
            status: job.status,
            serverProgress: job.serverProgress,
            error: job.error,
            expiresAt: job.cleanupAt
        })}\n\n`)
    }

    send()
    const timer = setInterval(send, 500)

    req.on('close', () => {
        clearInterval(timer)

        if (job.status === 'ready' || job.status === 'failed') {
            touchJob(job)
        }
    })
})

app.get('/download/file/:jobId', async (req, res) => {
    const job = jobs.get(req.params.jobId)

    if (!job) {
        res.status(404).json({ error: 'Job not found' })
        return
    }

    if (job.status !== 'ready') {
        res.status(409).json({ error: 'File is not ready yet' })
        return
    }

    touchJob(job)

    try {
        await fsp.access(job.filePath, fs.constants.R_OK)
    } catch {
        job.status = 'failed'
        job.error = 'Downloaded file is missing'
        scheduleJobCleanup(job)
        res.status(500).json({ error: 'Downloaded file is missing' })
        return
    }

    // Refresh TTL on each data chunk to handle slow downloads
    let lastTouchTime = Date.now()
    const touchInterval = setInterval(() => {
        if (Date.now() - lastTouchTime > 30000) {
            touchJob(job)
            lastTouchTime = Date.now()
        }
    }, 10000)

    req.on('close', () => {
        clearInterval(touchInterval)
        touchJob(job)
    })

    res.download(job.filePath, job.fileName, (error) => {
        clearInterval(touchInterval)
        if (error) {
            // Keep job available for a retry instead of deleting immediately.
            touchJob(job)
            return
        }

        // Keep temp file available briefly for manual re-downloads, then clean up.
        touchJob(job)
    })
})

app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.get('/download', handleDownload)
app.post('/download', handleDownload)

app.listen(port, host, () => {
    console.log(`Example app listening on ${host}:${port}`)
})

// Graceful shutdown: clean up all temp files
async function gracefulShutdown() {
    console.log('\n[Shutdown] Cleaning up temp files...')
    const cleanupPromises = []

    for (const job of jobs.values()) {
        cleanupPromises.push(
            fsp.unlink(job.filePath)
                .then(() => console.log(`[Cleanup] Deleted ${job.filePath}`))
                .catch((err) => console.log(`[Cleanup] Failed to delete ${job.filePath}: ${err.message}`))
        )
    }

    await Promise.all(cleanupPromises)
    console.log('[Shutdown] Done. Exiting.')
    process.exit(0)
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)
