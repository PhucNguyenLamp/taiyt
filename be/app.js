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
        createdAt: Date.now()
    }

    jobs.set(id, job)
    return job
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

    const onChunk = (chunk) => {
        const text = chunk.toString()
        const percent = parsePercent(text)

        if (percent !== null) {
            job.serverProgress = percent
        }
    }

    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    child.on('error', (error) => {
        job.status = 'failed'
        job.error = error?.code === 'ENOENT'
            ? 'yt-dlp is not installed. Install yt-dlp and make sure it is in PATH.'
            : String(error.message || error)
    })

    child.on('close', async (code) => {
        if (code === 0) {
            job.serverProgress = 100
            job.status = 'ready'
            return
        }

        job.status = 'failed'
        job.error = `yt-dlp failed with exit code ${code}`

        try {
            await fsp.unlink(job.filePath)
        } catch {
            // Ignore cleanup errors.
        }
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
    startJob(job)

    res.status(202).json({
        jobId: job.id,
        status: job.status,
        serverProgress: job.serverProgress,
        fileName: job.fileName
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
            error: job.error
        })}\n\n`)
    }

    send()
    const timer = setInterval(send, 500)

    req.on('close', () => {
        clearInterval(timer)
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

    try {
        await fsp.access(job.filePath, fs.constants.R_OK)
    } catch {
        job.status = 'failed'
        job.error = 'Downloaded file is missing'
        res.status(500).json({ error: 'Downloaded file is missing' })
        return
    }

    res.download(job.filePath, job.fileName, async () => {
        try {
            await fsp.unlink(job.filePath)
        } catch {
            // Ignore cleanup errors.
        }

        jobs.delete(job.id)
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
