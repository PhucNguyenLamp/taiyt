import { useState } from 'react'
import './App.css'

function App() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [serverProgress, setServerProgress] = useState(0)
  const [clientProgress, setClientProgress] = useState(0)

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
      setServerProgress(0)
      setClientProgress(0)

      const startResponse = await fetch('http://192.168.100.97:3000/download/start', {
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
      const { jobId, fileName } = startPayload

      await new Promise((resolve, reject) => {
        const progressSource = new EventSource(`http://192.168.100.97:3000/download/progress/${jobId}`)

        progressSource.onmessage = (event) => {
          const data = JSON.parse(event.data)
          const nextProgress = Math.round(Number(data.serverProgress || 0))
          setServerProgress(nextProgress)

          if (data.status === 'failed') {
            progressSource.close()
            reject(new Error(data.error || 'Server-side download failed.'))
            return
          }

          if (data.status === 'ready') {
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

      setMessage('Server download complete. Sending file to browser...')

      const response = await fetch(`http://192.168.100.97:3000/download/file/${jobId}`)

      if (!response.ok) {
        let errorText = 'Download failed.'

        try {
          const payload = await response.json()
          errorText = payload?.error || payload?.detail || errorText
        } catch {
          // Ignore JSON parse failures and keep fallback message.
        }

        throw new Error(errorText)
      }

      const totalBytes = Number.parseInt(response.headers.get('content-length') || '0', 10)
      const reader = response.body?.getReader()

      if (!reader) {
        throw new Error('Readable response stream is not available in this browser.')
      }

      const chunks = []
      let receivedBytes = 0

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        chunks.push(value)
        receivedBytes += value.length

        if (totalBytes > 0) {
          const percent = Math.round((receivedBytes / totalBytes) * 100)
          setClientProgress(Math.max(0, Math.min(100, percent)))
        }
      }

      const blob = new Blob(chunks, {
        type: response.headers.get('content-type') || 'video/mp4'
      })

      setClientProgress(100)
      const disposition = response.headers.get('content-disposition') || ''
      const nameMatch = disposition.match(/filename="?([^";]+)"?/) || []
      const resolvedFileName = fileName || nameMatch[1] || 'video.mp4'

      const blobUrl = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = blobUrl
      anchor.download = resolvedFileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(blobUrl)

      setStatus('success')
      setMessage('Download started in your browser.')
    } catch (error) {
      setStatus('error')
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

        <section className="progress-section" aria-live="polite">
          <div className="progress-row">
            <span>Server download</span>
            <strong>{serverProgress}%</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${serverProgress}%` }}></div>
          </div>

          <div className="progress-row">
            <span>Browser download</span>
            <strong>{clientProgress}%</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill browser" style={{ width: `${clientProgress}%` }}></div>
          </div>
        </section>
      </section>
    </main>
  )
}

export default App
