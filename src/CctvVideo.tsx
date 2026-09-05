import { useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import type { NearbyCctv } from './cctv'

const PLAYBACK_ERROR = '현재 CCTV 영상을 불러올 수 없습니다.'

/** Keep native Safari HLS first, and load hls.js only after opening a video. */
export default function CctvVideo({ cctv }: { cctv: NearbyCctv }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playbackError, setPlaybackError] = useState(false)
  const mixedContent = window.location.protocol === 'https:' && cctv.streamUrl.startsWith('http:')

  useEffect(() => {
    const video = videoRef.current
    if (!video || cctv.format === 'image') return
    let cancelled = false
    let hls: { destroy(): void } | undefined
    setPlaybackError(false)
    const fail = () => {
      if (cancelled) return
      const failedHls = hls
      hls = undefined
      failedHls?.destroy()
      video.removeAttribute('src')
      video.load()
      setPlaybackError(true)
    }
    const attach = async () => {
      if (mixedContent) return
      if (cctv.format !== 'hls' || video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = cctv.streamUrl
        video.load()
        return
      }
      try {
        const { default: Hls } = await import('hls.js')
        if (cancelled) return
        if (!Hls.isSupported()) { fail(); return }
        const instance = new Hls()
        hls = instance
        instance.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) fail() })
        instance.loadSource(cctv.streamUrl)
        instance.attachMedia(video)
      } catch { fail() }
    }
    void attach()
    return () => {
      cancelled = true
      hls?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [cctv.format, cctv.streamUrl, mixedContent])

  return (
    <div className="cctv-video">
      {!mixedContent && (cctv.format === 'image'
        ? !playbackError && <img src={cctv.streamUrl} alt={`${cctv.name} CCTV`} loading="lazy" onError={() => setPlaybackError(true)} />
        : <video ref={videoRef} controls playsInline preload="none" onError={() => setPlaybackError(true)} aria-label={`${cctv.name} CCTV 영상`} />)}
      {(playbackError || mixedContent) && (
        <p className="cctv-video-error" role="status"><AlertCircle className="size-4 shrink-0" aria-hidden="true" />{PLAYBACK_ERROR}</p>
      )}
    </div>
  )
}
