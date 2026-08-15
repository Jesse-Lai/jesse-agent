import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { approvalPromptText, approvalSurface, approvalTargetText } from '../presentation'
import type {
  ApprovalChoice,
  ApprovalRequest,
  ComposerAnnotation,
  ComposerImageAttachment,
  ImageMimeType,
  PendingApproval,
  QueuedComposerItem,
} from '../types'

const MAX_IMAGE_COUNT = 8
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_COMBINED_IMAGE_BYTES = 16 * 1024 * 1024

type ComposerPermissionMode = 'default' | 'plan'

interface ComposerProps {
  value: string
  running: boolean
  queuedPrompts: QueuedComposerItem[]
  queueStatus: string
  maxQueuedPrompts: number
  queueingEnabled: boolean
  activeProject: string
  permissionMode: ComposerPermissionMode
  annotations: ComposerAnnotation[]
  attachments: ComposerImageAttachment[]
  pendingApproval: PendingApproval | null
  formRef?: Ref<HTMLFormElement>
  onChange: (value: string) => void
  onPermissionModeChange: (value: ComposerPermissionMode) => void
  onApproval: (request: ApprovalRequest, choice: ApprovalChoice) => Promise<void>
  onRemoveAnnotation: (id: string) => void
  onAddAttachments: (attachments: ComposerImageAttachment[]) => void
  onRemoveAttachment: (id: string) => void
  onSubmit: () => void
  onCancel: () => void
  onQueue: () => void
  onQueuedEdit: (id: string) => void
  onQueuedDelete: (id: string) => void
  onQueuedSteer: (id: string) => void
  onTurnOffQueueing: () => void
}

export function Composer({
  value,
  running,
  queuedPrompts,
  queueStatus,
  maxQueuedPrompts,
  queueingEnabled,
  activeProject,
  permissionMode,
  annotations,
  attachments,
  pendingApproval,
  formRef,
  onChange,
  onPermissionModeChange,
  onApproval,
  onRemoveAnnotation,
  onAddAttachments,
  onRemoveAttachment,
  onSubmit,
  onCancel,
  onQueue,
  onQueuedEdit,
  onQueuedDelete,
  onQueuedSteer,
  onTurnOffQueueing,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const modeControlRef = useRef<HTMLDivElement>(null)
  const wasRunning = useRef(running)
  const [queueMenuOpen, setQueueMenuOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)
  const [attachmentError, setAttachmentError] = useState('')
  const [draggingImages, setDraggingImages] = useState(false)
  const [modeMenuPosition, setModeMenuPosition] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = textarea.scrollHeight + 'px'
  }, [value])

  useEffect(() => {
    if (wasRunning.current && !running) textareaRef.current?.focus()
    wasRunning.current = running
  }, [running])

  useEffect(() => {
    if (!pendingApproval) setApprovalMenuOpen(false)
  }, [pendingApproval])

  useEffect(() => {
    if (queuedPrompts.length === 0) setQueueMenuOpen(false)
  }, [queuedPrompts.length])

  useEffect(() => {
    if (!modeMenuOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.composer-mode-menu')) return
      if (target instanceof Node && modeControlRef.current?.contains(target)) return
      setModeMenuOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [modeMenuOpen])

  useLayoutEffect(() => {
    if (!modeMenuOpen) {
      setModeMenuPosition(null)
      return
    }

    const updateMenuPosition = () => {
      const anchor = modeControlRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const menuWidth = 220
      const menuHeight = 104
      const viewportPadding = 8
      const left = Math.max(viewportPadding, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding))
      const preferredTop = rect.top - menuHeight - 8
      const top = preferredTop >= viewportPadding
        ? preferredTop
        : Math.min(rect.bottom + 8, window.innerHeight - menuHeight - viewportPadding)
      setModeMenuPosition({ left, top: Math.max(viewportPadding, top) })
    }

    updateMenuPosition()
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [modeMenuOpen])

  const submit = () => {
    if (running) onCancel()
    else onSubmit()
  }

  const submitFromKeyboard = () => {
    if (running) {
      if (queueingEnabled && (value.trim() || annotations.length > 0)) onQueue()
      return
    }
    onSubmit()
  }

  const selectMode = (mode: ComposerPermissionMode) => {
    onPermissionModeChange(mode)
    setModeMenuOpen(false)
  }

  const addImageFiles = async (files: File[]) => {
    if (running || files.length === 0) return
    try {
      const next = await prepareImageAttachments(files, attachments)
      onAddAttachments(next)
      setAttachmentError('')
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error))
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  const modeLabel = permissionMode === 'plan' ? 'Plan' : 'Ask for approval'
  const canSubmit = Boolean(value.trim() || annotations.length > 0 || attachments.length > 0)

  return (
    <form ref={formRef} className="composer" onSubmit={event => { event.preventDefault(); submit() }}>
      <div className={'composer-shadow-wrap' + (modeMenuOpen ? ' mode-menu-open' : '')}>
        {pendingApproval ? (
          <ApprovalPrompt
            approval={pendingApproval}
            allowMenuOpen={approvalMenuOpen}
            onToggleAllowMenu={() => setApprovalMenuOpen(open => !open)}
            onApproval={(request, choice) => {
              setApprovalMenuOpen(false)
              void onApproval(request, choice)
            }}
          />
        ) : null}
        {queuedPrompts.length > 0 ? (
          <section className="queued-message-list" aria-label="Queued prompts">
            <header className="queued-list-header">
              <div className="queued-list-title">
                <span className="queued-list-icon" aria-hidden="true" />
                <span>Queue</span>
              </div>
              <div className="queued-list-tools">
                <span className="queued-list-count">{queuedPrompts.length}/{maxQueuedPrompts}</span>
                <button
                  type="button"
                  aria-label="Queue options"
                  aria-expanded={queueMenuOpen}
                  title="Queue options"
                  onClick={() => setQueueMenuOpen(open => !open)}
                >
                  <span className="fluent-icon icon-more-vertical" aria-hidden="true" />
                </button>
                {queueMenuOpen ? (
                  <div className="queued-menu">
                    <button type="button" onClick={() => { setQueueMenuOpen(false); onTurnOffQueueing() }}>Turn off queueing</button>
                  </div>
                ) : null}
              </div>
            </header>
            <div className="queued-list-body">
              {queuedPrompts.map((item, index) => (
                <article className="queued-message-row" key={item.id}>
                  <span className="queued-message-index" aria-hidden="true">{index + 1}</span>
                  <div className="queued-message-copy">
                    <span className="queued-text" title={item.text}>{item.text}</span>
                    {item.mode === 'steer' ? <span className="queued-mode-label">Steer</span> : null}
                  </div>
                  <div className="queued-row-actions">
                    <button
                      className={item.mode === 'steer' ? 'is-active' : ''}
                      type="button"
                      aria-label={`Steer queued prompt ${index + 1}`}
                      onClick={() => onQueuedSteer(item.id)}
                    >
                      Steer
                    </button>
                    <button type="button" aria-label={`Edit queued prompt ${index + 1}`} onClick={() => onQueuedEdit(item.id)}>Edit</button>
                    <button
                      className="queued-delete-button"
                      type="button"
                      aria-label={`Delete queued prompt ${index + 1}`}
                      title="Delete"
                      onClick={() => onQueuedDelete(item.id)}
                    >
                      <span className="fluent-icon icon-delete" aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {queueStatus ? <div className="queued-status" role="status">{queueStatus}</div> : null}
          </section>
        ) : null}
        <div
          className={'composer-shell' + (draggingImages ? ' is-dragging-images' : '')}
          data-squircle-stroke="var(--composer-stroke)"
          data-squircle-stroke-width="0.5"
          onDragEnter={event => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            setDraggingImages(true)
          }}
          onDragOver={event => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDragLeave={event => {
            const nextTarget = event.relatedTarget
            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
            setDraggingImages(false)
          }}
          onDrop={event => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            setDraggingImages(false)
            void addImageFiles(Array.from(event.dataTransfer.files))
          }}
        >
          <input
            ref={imageInputRef}
            className="composer-image-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            multiple
            tabIndex={-1}
            onChange={event => void addImageFiles(Array.from(event.target.files ?? []))}
          />
          {attachments.length > 0 ? (
            <div className="composer-image-previews" aria-label="Attached images">
              {attachments.map(attachment => (
                <div className="composer-image-preview" key={attachment.id}>
                  <img src={attachment.dataURL} alt={attachment.name || 'Attached image'} />
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name || 'attached image'}`}
                    title="Remove image"
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {annotations.length > 0 ? (
            <div className="composer-annotations" aria-label="Referenced annotations">
              <div className="composer-annotation-summary">
                <span className="annotation-icon" aria-hidden="true" />
                <span>{annotations.length === 1 ? '1 annotation' : annotations.length + ' annotations'}</span>
              </div>
              <div className="composer-annotation-list">
                {annotations.map(annotation => (
                  <div key={annotation.id} className="composer-annotation-item" title={annotation.text}>
                    <span>{annotation.label}</span>
                    <button type="button" aria-label="Remove annotation" title="Remove annotation" onClick={() => onRemoveAnnotation(annotation.id)}>×</button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {attachmentError ? <div className="composer-attachment-error" role="alert">{attachmentError}</div> : null}
          <div className="composer-input-row">
            <button
              className="composer-attachment-button"
              type="button"
              aria-label="Attach images"
              title="Attach images"
              disabled={running || attachments.length >= MAX_IMAGE_COUNT}
              onClick={() => imageInputRef.current?.click()}
            >
              <span className="fluent-icon icon-add" aria-hidden="true" />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Do Anything"
              value={value}
              onChange={event => onChange(event.target.value)}
              onPaste={event => {
                const imageFiles = Array.from(event.clipboardData.files).filter(isImageFile)
                if (imageFiles.length === 0) return
                event.preventDefault()
                void addImageFiles(imageFiles)
              }}
              onKeyDown={event => {
                const nativeEvent = event.nativeEvent
                if (event.key !== 'Enter' || event.shiftKey || nativeEvent.isComposing || nativeEvent.keyCode === 229) return
                event.preventDefault()
                submitFromKeyboard()
              }}
            />
            <div ref={modeControlRef} className="composer-mode-control">
              <button
                className={'composer-mode-chip' + (modeMenuOpen ? ' active' : '')}
                type="button"
                aria-label="Change permission mode"
                aria-expanded={modeMenuOpen}
                aria-haspopup="menu"
                title={permissionMode === 'plan' ? 'Plan mode: read and inspect only' : 'Ask before file edits and commands'}
                onClick={() => setModeMenuOpen(open => !open)}
              >
                {modeLabel}
              </button>
              {modeMenuOpen && modeMenuPosition ? createPortal(
                <div className="composer-mode-menu" role="menu" style={{ left: modeMenuPosition.left, top: modeMenuPosition.top }}>
                  <ModeButton
                    label="Ask for approval"
                    description="Ask before edits and commands"
                    active={permissionMode === 'default'}
                    onClick={() => selectMode('default')}
                  />
                  <ModeButton
                    label="Plan"
                    description="Read and inspect only"
                    active={permissionMode === 'plan'}
                    onClick={() => selectMode('plan')}
                  />
                </div>,
                document.body,
              ) : null}
            </div>
            <div className="composer-actions">
              <button
                className={'send-button' + (running ? ' is-running' : '')}
                type="submit"
                aria-label={running ? 'Stop' : 'Send'}
                title={running ? 'Stop' : 'Send'}
                disabled={running ? false : !canSubmit || !activeProject}
              >
                <span className={'fluent-icon ' + (running ? 'icon-stop' : 'icon-arrow-up')} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  )
}

function ApprovalPrompt({
  approval,
  allowMenuOpen,
  onToggleAllowMenu,
  onApproval,
}: {
  approval: PendingApproval
  allowMenuOpen: boolean
  onToggleAllowMenu: () => void
  onApproval: (request: ApprovalRequest, choice: ApprovalChoice) => void
}) {
  const { request, disabled, error } = approval
  const target = approvalTargetText(request)

  return (
    <div className="approval-prompt" data-approval-id={request.id}>
      <div className="approval-prompt-main">
        <div className="approval-prompt-source">
          <span className="approval-source-icon" aria-hidden="true" />
          <span>{approvalSurface(request)}</span>
        </div>
        <div className="approval-prompt-copy">{approvalPromptText(request)}</div>
        <code className="approval-prompt-target" title={target}>{target}</code>
        {error ? <div className="approval-prompt-error">{error}</div> : null}
      </div>
      <div className="approval-prompt-actions">
        <button
          type="button"
          className="approval-deny-button"
          disabled={disabled}
          onClick={() => onApproval(request, 'reject_once')}
        >
          <span className="fluent-icon icon-dismiss-circle" aria-hidden="true" />
          <span>Deny</span>
        </button>
        <div className="approval-allow-group">
          <button
            type="button"
            className="approval-allow-button"
            disabled={disabled}
            onClick={() => onApproval(request, 'allow_once')}
          >
            <span className="fluent-icon icon-checkmark-circle" aria-hidden="true" />
            <span>{disabled ? approval.status : 'Allow once'}</span>
          </button>
          <button
            type="button"
            className="approval-allow-menu-button"
            aria-label="More approval options"
            aria-expanded={allowMenuOpen}
            disabled={disabled}
            onClick={onToggleAllowMenu}
          >
            <span aria-hidden="true">⌄</span>
          </button>
          {allowMenuOpen ? (
            <div className="approval-allow-menu">
              <button type="button" onClick={() => onApproval(request, 'allow_for_session')}>Allow for session</button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ModeButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string
  description: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button className={active ? 'active' : ''} type="button" role="menuitemradio" aria-checked={active} onClick={onClick}>
      <span>{label}</span>
      <span>{description}</span>
    </button>
  )
}

/** Turns browser Files into the same inline image payload understood by the agent protocol. */
async function prepareImageAttachments(
  files: File[],
  existing: ComposerImageAttachment[],
): Promise<ComposerImageAttachment[]> {
  if (existing.length + files.length > MAX_IMAGE_COUNT) {
    throw new Error(`You can attach up to ${MAX_IMAGE_COUNT} images.`)
  }

  const normalized = files.map(file => ({ file, mimeType: imageMimeType(file) }))
  const unsupported = normalized.find(candidate => !candidate.mimeType)
  if (unsupported) throw new Error('Only PNG, JPEG, and WebP images are supported.')

  const oversized = normalized.find(candidate => candidate.file.size > MAX_IMAGE_BYTES)
  if (oversized) throw new Error(`${oversized.file.name || 'An image'} is larger than 16 MB.`)

  const combinedBytes = existing.reduce((total, attachment) => total + (attachment.byteLength ?? 0), 0)
    + normalized.reduce((total, candidate) => total + candidate.file.size, 0)
  if (combinedBytes > MAX_COMBINED_IMAGE_BYTES) {
    throw new Error('Attached images can be up to 16 MB in total.')
  }

  return Promise.all(normalized.map(async ({ file, mimeType }) => {
    const dataURL = await readImageDataURL(file, mimeType!)
    const dimensions = await readImageDimensions(dataURL)
    return {
      id: createAttachmentId(),
      type: 'image' as const,
      mimeType: mimeType!,
      dataURL,
      name: file.name || 'Attached image',
      byteLength: file.size,
      width: dimensions.width,
      height: dimensions.height,
      source: 'user' as const,
    }
  }))
}

function imageMimeType(file: File): ImageMimeType | null {
  const declared = file.type.toLowerCase()
  if (declared === 'image/png' || declared === 'image/jpeg' || declared === 'image/webp') return declared
  const extension = file.name.toLowerCase().split('.').pop()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  return null
}

function isImageFile(file: File): boolean {
  return imageMimeType(file) !== null
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

function readImageDataURL(file: File, mimeType: ImageMimeType): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the image'}.`))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma === -1) {
        reject(new Error(`Could not read ${file.name || 'the image'}.`))
        return
      }
      resolve(`data:${mimeType};base64,${result.slice(comma + 1)}`)
    }
    reader.readAsDataURL(file)
  })
}

function readImageDimensions(dataURL: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('One of the selected images could not be decoded.'))
    image.src = dataURL
  })
}

function createAttachmentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
