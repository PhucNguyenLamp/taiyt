import { useState } from 'react'
import './App.css'

const API_PORT = import.meta.env.VITE_API_PORT || '3000'
const API_BASE = import.meta.env.VITE_API_BASE?.trim()
  || `${window.location.protocol}//${window.location.hostname}:${API_PORT}`

function App() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [serverProgress, setServerProgress] = useState(0)

  // async function onPasteClick() {
  //   if (!navigator.clipboard?.readText) {
  //     setStatus('error')
  //     setMessage('Clipboard access is not available here. Paste manually with Ctrl+V.')
  //     return
  //   }

  //   try {
  //     const clipboardText = (await navigator.clipboard.readText()).trim()

  //     if (!clipboardText) {
  //       setStatus('error')
  //       setMessage('Clipboard is empty.')
  //       return
  //     }

  //     setUrl(clipboardText)
  //     setStatus('idle')
  //     setMessage('Link pasted from clipboard.')
  //   } catch {
  //     setStatus('error')
  //     setMessage('Clipboard permission denied. Paste manually with Ctrl+V.')
  //   }
  // }

  async function onSubmit(event) {
    event.preventDefault()

    if (!url.trim()) {
      setStatus('error')
      setMessage('Please enter a YouTube URL.')
      return
    }

    try {
      setStatus('loading')
      setMessage('Server download started...')
      setDownloadUrl('')
      setServerProgress(0)

      const startResponse = await fetch(`${API_BASE}/download/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: url.trim() })
      })
      if (!startResponse.ok) {
        const payload = await startResponse.json().catch(() => ({}))
        throw new Error(payload?.error || payload?.detail || 'Failed to start download job.')
      }

      const startPayload = await startResponse.json()
      const { jobId, downloadPath } = startPayload
      console.log(`[Frontend] Started job ${jobId}`)

      await new Promise((resolve, reject) => {
        const progressSource = new EventSource(`${API_BASE}/download/progress/${jobId}`)
        console.log(`[Frontend] Opened EventSource for ${jobId}`)

        progressSource.onmessage = (event) => {
          const data = JSON.parse(event.data)
          const nextProgress = Math.round(Number(data.serverProgress || 0))
          // console.log(`[Frontend] Progress: ${nextProgress}%, Status: ${data.status}`)
          setServerProgress(nextProgress)

          if (data.status === 'failed') {
            progressSource.close()
            reject(new Error(data.error || 'Server-side download failed.'))
            return
          }

          if (data.status === 'ready') {
            console.log(`[Frontend] Download ready, closing EventSource`)
            setServerProgress(100)
            progressSource.close()
            resolve()
          }
        }

        progressSource.onerror = () => {
          progressSource.close()
          reject(new Error('Lost server progress connection.'))
        }
      })

      setMessage('Server download complete. Your link is ready.')

      const resolvedDownloadUrl = downloadPath
        ? `${API_BASE}${downloadPath}`
        : `${API_BASE}/download/file/${jobId}`

      setDownloadUrl(resolvedDownloadUrl)

      const anchor = document.createElement('a')
      anchor.href = resolvedDownloadUrl
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()

      setStatus('success')
      setMessage('Download started. You can reuse the direct link below for 5 minutes.')
    } catch (error) {
      setStatus('error')
      setDownloadUrl('')
      setMessage(error.message || 'Download failed.')
    }
  }

  return (
    <main className="page">
      <section className="card">
        <h1>YouTube Downloader</h1>
        <p className="subtitle">Paste a YouTube link, then download the MP4 from your backend.</p>

        <form className="form" onSubmit={onSubmit}>
          <label htmlFor="yt-url">YouTube URL</label>
          <div className="input-row">
            <input
              id="yt-url"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
            {/* <button
              type="button"
              className="paste-button"
              onClick={onPasteClick}
              disabled={status === 'loading'}
            >
              Paste
            </button> */}
          </div>
          <button type="submit" disabled={status === 'loading'}>
            {status === 'loading' ? 'Downloading...' : 'Download Video'}
          </button>
        </form>

        <p className={`status ${status}`}>{message || 'Ready'}</p>

        {downloadUrl ? (
          <p className="status break-all success">
            Direct link:{' '}
            <a href={downloadUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all', overflowWrap: 'break-word' }}>
              {downloadUrl}
            </a>
          </p>
        ) : null}

        <section className="progress-section" aria-live="polite">
          <div className="progress-row">
            <span>Server download</span>
            <strong>{serverProgress}%</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${serverProgress}%` }}></div>
          </div>
        </section>
      </section>
    </main>
  )
}

export default App
