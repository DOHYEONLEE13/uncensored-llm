import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Radio, X } from 'lucide-react'
import { formatCctvDistance, formatCctvRoadType, type CctvCamera } from './cctv'
import CctvVideo from './CctvVideo'

export default function CctvVideoDialog({ cctv, onClose }: { cctv: CctvCamera; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current!
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    dialog.showModal()
    closeRef.current?.focus()
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.close()
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <dialog ref={dialogRef} className="cctv-video-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}>
      <div className="cctv-dialog-heading">
        <div className="cctv-dialog-title">
          <span className="cctv-dialog-label"><Radio size={14} aria-hidden="true" /> ITS CCTV</span>
          <h2 id={titleId}>{cctv.name}</h2>
          <p>{cctv.distanceMeters !== undefined && `직선 ${formatCctvDistance(cctv.distanceMeters)} · `}{formatCctvRoadType(cctv.roadType)}</p>
        </div>
        <button ref={closeRef} type="button" className="cctv-close" aria-label="CCTV 영상 팝업 닫기" onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </div>
      <CctvVideo cctv={cctv} autoPlay />
      <p className="cctv-dialog-caption">음소거로 재생됩니다. 영상의 재생·음량 버튼으로 조절할 수 있습니다.</p>
    </dialog>, document.body,
  )
}
