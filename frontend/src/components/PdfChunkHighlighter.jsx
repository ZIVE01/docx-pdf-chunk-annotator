import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import api from '../lib/api'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

const MIN_RECT_SIZE = 12
const AUTO_RECT_PADDING = 5

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('\u0451', '\u0435')
    .replace(/[^0-9a-z\u0430-\u044f]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeRect(bbox) {
  if (!bbox) return null
  const x1 = Number(bbox.x1)
  const y1 = Number(bbox.y1)
  const x2 = Number(bbox.x2)
  const y2 = Number(bbox.y2)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null

  return {
    ...bbox,
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
  }
}

function normalizeRegions(bbox) {
  if (!bbox) return []
  if (Array.isArray(bbox.regions)) {
    return bbox.regions
      .map((region, index) => {
        const rect = normalizeRect(region)
        if (!rect) return null
        return {
          ...rect,
          id: region.id || `region-${index}`,
          page: Number(region.page || bbox.page || 1),
          unit: region.unit || bbox.unit || 'pdf_points',
        }
      })
      .filter(Boolean)
  }

  const rect = normalizeRect(bbox)
  if (!rect) return []
  return [{
    ...rect,
    id: bbox.id || 'region-0',
    page: Number(bbox.page || 1),
    unit: bbox.unit || 'pdf_points',
  }]
}

function makeRegionsBbox(regions) {
  const normalized = regions
    .map((region, index) => ({
      ...region,
      id: region.id || `region-${index}-${Date.now()}`,
      page: Number(region.page || 1),
      unit: 'pdf_points',
    }))
    .filter((region) => Number.isFinite(region.x1) && Number.isFinite(region.y1) && Number.isFinite(region.x2) && Number.isFinite(region.y2))

  if (normalized.length === 0) return null
  return {
    unit: 'pdf_points',
    regions: normalized,
  }
}

function clampRect(rect, pageWidth, pageHeight) {
  const width = Math.max(MIN_RECT_SIZE, rect.x2 - rect.x1)
  const height = Math.max(MIN_RECT_SIZE, rect.y2 - rect.y1)
  const x1 = Math.min(Math.max(0, rect.x1), Math.max(0, pageWidth - width))
  const y1 = Math.min(Math.max(0, rect.y1), Math.max(0, pageHeight - height))

  return {
    ...rect,
    x1,
    y1,
    x2: Math.min(pageWidth, x1 + width),
    y2: Math.min(pageHeight, y1 + height),
  }
}

function defaultRect(pageWidth, pageHeight, pageNumber) {
  return {
    x1: pageWidth * 0.12,
    y1: pageHeight * 0.38,
    x2: pageWidth * 0.88,
    y2: pageHeight * 0.48,
    page: pageNumber,
    unit: 'pdf_points',
  }
}

function textItemRect(viewport, item) {
  const transform = pdfjs.Util.transform(viewport.transform, item.transform)
  const x = transform[4]
  const y = transform[5]
  const width = Math.max(1, item.width || Math.abs(transform[0]) || 1)
  const height = Math.max(7, item.height || Math.abs(transform[3]) || Math.abs(transform[0]) || 7)

  return {
    x1: x,
    y1: y - height,
    x2: x + width,
    y2: y + 2,
  }
}

function unionRects(rects, pageWidth, pageHeight, pageNumber) {
  const x1 = Math.max(0, Math.min(...rects.map((rect) => rect.x1)) - AUTO_RECT_PADDING)
  const y1 = Math.max(0, Math.min(...rects.map((rect) => rect.y1)) - AUTO_RECT_PADDING)
  const x2 = Math.min(pageWidth, Math.max(...rects.map((rect) => rect.x2)) + AUTO_RECT_PADDING)
  const y2 = Math.min(pageHeight, Math.max(...rects.map((rect) => rect.y2)) + AUTO_RECT_PADDING)
  return { x1, y1, x2, y2, page: pageNumber, unit: 'pdf_points' }
}

function searchCandidates(text) {
  const full = normalizeSearchText(text)
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeSearchText)
    .filter((line) => line.length >= 10)
  const words = full.split(' ').filter(Boolean)
  const wordWindows = [18, 14, 10, 7]
    .filter((size) => words.length >= size)
    .map((size) => words.slice(0, size).join(' '))

  return [...new Set([full, ...lines, ...wordWindows].filter((item) => item.length >= 10))]
    .sort((a, b) => b.length - a.length)
}

async function findChunkRectInPdf(pdf, chunk, onlyPage = null) {
  const candidates = searchCandidates(chunk?.text)
  if (!pdf || candidates.length === 0) return null

  const preferredPage = Number(chunk?.page_number || chunk?.bbox?.page)
  const pageNumbers = []
  if (onlyPage > 0 && onlyPage <= pdf.numPages) {
    pageNumbers.push(onlyPage)
  } else {
    if (preferredPage > 0 && preferredPage <= pdf.numPages) pageNumbers.push(preferredPage)
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (!pageNumbers.includes(pageNumber)) pageNumbers.push(pageNumber)
    }
  }

  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = content.items
      .map((item, index) => ({
        index,
        normalized: normalizeSearchText(item.str),
        rect: textItemRect(viewport, item),
      }))
      .filter((item) => item.normalized)

    let combined = ''
    const spans = []
    for (const item of items) {
      const separatorLength = combined ? 1 : 0
      const start = combined.length + separatorLength
      combined = combined ? `${combined} ${item.normalized}` : item.normalized
      spans.push({ start, end: combined.length, index: item.index })
    }

    for (const candidate of candidates) {
      const position = combined.indexOf(candidate)
      if (position < 0) continue

      const end = position + candidate.length
      const rects = spans
        .filter((span) => span.end >= position && span.start <= end)
        .map((span) => items.find((item) => item.index === span.index)?.rect)
        .filter(Boolean)

      if (rects.length > 0) {
        return unionRects(rects, viewport.width, viewport.height, pageNumber)
      }
    }
  }

  return null
}

const HANDLE_STYLES = {
  nw: { left: -5, top: -5, cursor: 'nwse-resize' },
  n: { left: '50%', top: -5, transform: 'translateX(-50%)', cursor: 'ns-resize' },
  ne: { right: -5, top: -5, cursor: 'nesw-resize' },
  e: { right: -5, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' },
  se: { right: -5, bottom: -5, cursor: 'nwse-resize' },
  s: { left: '50%', bottom: -5, transform: 'translateX(-50%)', cursor: 'ns-resize' },
  sw: { left: -5, bottom: -5, cursor: 'nesw-resize' },
  w: { left: -5, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' },
}

export default function PdfChunkHighlighter({
  docId,
  pdfUrl,
  chunks,
  activeChunkIndex,
  onActiveChunkChange,
  onChunkGeometryChange,
  currentPage: controlledCurrentPage,
  onCurrentPageChange,
  active = true,
  autoPlaceRequest = 0,
}) {
  const canvasRef = useRef(null)
  const renderTaskRef = useRef(null)
  const pdfRef = useRef(null)
  const autoSuppressedRef = useRef(new Set())
  const lastAutoPlaceRequestRef = useRef(0)

  const [totalPages, setTotalPages] = useState(0)
  const [internalCurrentPage, setInternalCurrentPage] = useState(Number(controlledCurrentPage) || 1)
  const [scale, setScale] = useState(1.35)
  const [viewport, setViewport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoStatus, setAutoStatus] = useState('')
  const [autoPlacing, setAutoPlacing] = useState(false)
  const [interaction, setInteraction] = useState(null)

  const activeChunk = useMemo(
    () => chunks.find((chunk) => chunk.chunk_index === activeChunkIndex) || null,
    [activeChunkIndex, chunks]
  )
  const activeRegions = useMemo(() => normalizeRegions(activeChunk?.bbox), [activeChunk])
  const currentPage = Number(controlledCurrentPage || internalCurrentPage || 1)
  const activePageRegionIndex = activeRegions.findIndex((region) => Number(region.page) === currentPage)
  const canRemoveRegion = Boolean(activeChunk && (activePageRegionIndex >= 0 || activeRegions.length === 1))

  const pageWidth = viewport ? viewport.width / scale : 0
  const pageHeight = viewport ? viewport.height / scale : 0

  const renderPageRef = useRef(null)
  const sourceKey = pdfUrl || docId || 'manual'

  const setPdfPage = useCallback((valueOrUpdater) => {
    const nextValue = typeof valueOrUpdater === 'function'
      ? valueOrUpdater(currentPage)
      : valueOrUpdater
    const nextPage = Math.max(1, Number(nextValue) || 1)
    setInternalCurrentPage(nextPage)
    onCurrentPageChange?.(nextPage)
  }, [currentPage, onCurrentPageChange])

  const autoStateKey = useCallback((chunkIndex) => `${sourceKey}:${chunkIndex}`, [sourceKey])

  const suppressAutoRegion = useCallback((chunkIndex) => {
    const key = autoStateKey(chunkIndex)
    autoSuppressedRef.current.add(key)
    try {
      window.sessionStorage.setItem(`pdf-region-auto-suppressed:${key}`, '1')
    } catch {
      // Ignore storage restrictions; the in-memory ref still works until unmount.
    }
  }, [autoStateKey])

  const allowAutoRegion = useCallback((chunkIndex) => {
    const key = autoStateKey(chunkIndex)
    autoSuppressedRef.current.delete(key)
    try {
      window.sessionStorage.removeItem(`pdf-region-auto-suppressed:${key}`)
    } catch {
      // Ignore storage restrictions.
    }
  }, [autoStateKey])

  useEffect(() => {
    const sourceUrl = pdfUrl || (docId ? `/documents/${docId}/pdf` : null)
    if (!sourceUrl) return
    setLoading(true)
    setError('')
    setAutoStatus('')
    let cancelled = false

    api.get(sourceUrl, { responseType: 'arraybuffer' })
      .then(({ data }) => {
        if (cancelled) return null
        return pdfjs.getDocument({ data: new Uint8Array(data) }).promise
      })
      .then((pdf) => {
        if (cancelled || !pdf) return
        pdfRef.current = pdf
        setTotalPages(pdf.numPages)
        setLoading(false)
        renderPageRef.current?.()
      })
      .catch((err) => {
        if (cancelled) return
        const detail = err?.response?.data?.detail
        setError(detail || (err?.message || String(err)).slice(0, 180))
        setLoading(false)
      })

    return () => {
      cancelled = true
      if (renderTaskRef.current) renderTaskRef.current.cancel()
      pdfRef.current = null
    }
  }, [docId, pdfUrl])

  useEffect(() => {
    if (totalPages && currentPage > totalPages) {
      setPdfPage(totalPages)
    }
  }, [currentPage, setPdfPage, totalPages])

  useEffect(() => {
    const firstRegion = normalizeRegions(activeChunk?.bbox)[0]
    const page = Number(firstRegion?.page)
    if (page > 0) setPdfPage(page)
  }, [activeChunk?.chunk_index, docId])

  const renderPage = useCallback(async () => {
    const pdf = pdfRef.current
    if (!active || !pdf || !canvasRef.current) return

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
      renderTaskRef.current = null
    }

    await new Promise((resolve) => requestAnimationFrame(resolve))
    if (!canvasRef.current || pdfRef.current !== pdf) return

    const page = await pdf.getPage(currentPage)
    const vp = page.getViewport({ scale })
    setViewport(vp)

    const canvas = canvasRef.current
    canvas.width = vp.width
    canvas.height = vp.height

    const context = canvas.getContext('2d')
    context.save()
    context.globalCompositeOperation = 'source-over'
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.restore()

    const task = page.render({ canvasContext: context, viewport: vp, background: 'rgb(255,255,255)' })
    renderTaskRef.current = task

    try {
      await task.promise
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.error(err)
    } finally {
      if (renderTaskRef.current === task) {
        renderTaskRef.current = null
      }
    }
  }, [active, currentPage, scale])

  useEffect(() => { renderPageRef.current = renderPage }, [renderPage])
  useEffect(() => { if (pdfRef.current) renderPage() }, [renderPage, totalPages])

  const setChunkRegion = useCallback((chunkIndex, regionIndex, rect) => {
    if (!pageWidth || !pageHeight) return
    const sourceRect = normalizeRect(rect)
    if (!sourceRect) return
    const nextRect = {
      ...clampRect(sourceRect, pageWidth, pageHeight),
      id: sourceRect.id || `region-${Date.now()}`,
      page: Number(sourceRect.page || currentPage),
      unit: 'pdf_points',
    }
    const chunk = chunks.find((item) => item.chunk_index === chunkIndex)
    const regions = normalizeRegions(chunk?.bbox)

    if (regionIndex >= 0 && regionIndex < regions.length) {
      regions[regionIndex] = nextRect
    } else {
      regions.push(nextRect)
    }

    onChunkGeometryChange(chunkIndex, {
      bbox: makeRegionsBbox(regions),
      page_number: Number(nextRect.page) || currentPage,
    })
    allowAutoRegion(chunkIndex)
  }, [allowAutoRegion, chunks, currentPage, onChunkGeometryChange, pageHeight, pageWidth])

  const ensureActiveRect = async ({ autoSearch = false } = {}) => {
    if (!activeChunk || !pageWidth || !pageHeight) return
    const regions = normalizeRegions(activeChunk.bbox)
    const currentRegionIndex = regions.findIndex((region) => Number(region.page) === currentPage)

    if (currentRegionIndex >= 0) {
      const existing = regions[currentRegionIndex]
      setChunkRegion(activeChunk.chunk_index, currentRegionIndex, { ...existing, page: currentPage, unit: 'pdf_points' })
      return
    }

    if (autoSearch) {
      setAutoStatus('Searching for chunk text in the PDF...')
      const detected = await findChunkRectInPdf(pdfRef.current, activeChunk, regions.length > 0 ? currentPage : null)
      if (detected) {
        setPdfPage(detected.page)
        const targetIndex = regions.findIndex((region) => Number(region.page) === detected.page)
        setChunkRegion(activeChunk.chunk_index, targetIndex, detected)
        setAutoStatus(`Region found automatically: page ${detected.page}`)
        return
      }
    }

    const rect = defaultRect(pageWidth, pageHeight, currentPage)
    setChunkRegion(activeChunk.chunk_index, -1, rect)
    setAutoStatus(autoSearch
      ? 'Text was not found; a region was placed for manual adjustment'
      : `Region created on the current page: ${currentPage}`)
  }

  const autoPlaceMissingRegions = useCallback(async () => {
    if (!pdfRef.current || !pageWidth || !pageHeight) return
    const missingChunks = chunks.filter((chunk) => normalizeRegions(chunk.bbox).length === 0)
    if (missingChunks.length === 0) {
      setAutoStatus('All chunks already have PDF regions')
      return
    }

    setAutoPlacing(true)
    let placed = 0
    try {
      for (const chunk of missingChunks) {
        setAutoStatus(`Auto-placing chunk #${chunk.chunk_index}`)
        const detected = await findChunkRectInPdf(pdfRef.current, chunk)
        if (!detected) continue

        const region = {
          ...detected,
          id: `region-${Date.now()}-${chunk.chunk_index}`,
          unit: 'pdf_points',
        }
        onChunkGeometryChange(chunk.chunk_index, {
          bbox: makeRegionsBbox([region]),
          page_number: Number(region.page) || chunk.page_number || null,
        })
        allowAutoRegion(chunk.chunk_index)
        placed += 1
      }

      setAutoStatus(`Auto-placement complete: ${placed} of ${missingChunks.length}`)
    } finally {
      setAutoPlacing(false)
    }
  }, [allowAutoRegion, chunks, onChunkGeometryChange, pageHeight, pageWidth])

  useEffect(() => {
    if (!active || !autoPlaceRequest || !viewport || !pdfRef.current) return
    if (lastAutoPlaceRequestRef.current === autoPlaceRequest) return

    lastAutoPlaceRequestRef.current = autoPlaceRequest
    autoPlaceMissingRegions()
  }, [active, autoPlaceMissingRegions, autoPlaceRequest, viewport])

  const removeActiveRect = () => {
    if (!activeChunk) return
    const regions = normalizeRegions(activeChunk.bbox)
    const removeIndex = activePageRegionIndex >= 0 ? activePageRegionIndex : (regions.length === 1 ? 0 : -1)
    if (removeIndex < 0) return

    const nextRegions = regions.filter((_, index) => index !== removeIndex)
    if (nextRegions.length === 0) {
      suppressAutoRegion(activeChunk.chunk_index)
    } else {
      allowAutoRegion(activeChunk.chunk_index)
    }
    onChunkGeometryChange(activeChunk.chunk_index, {
      bbox: makeRegionsBbox(nextRegions),
      page_number: nextRegions[0]?.page || activeChunk.page_number || null,
    })
  }

  const startInteraction = (event, chunk, regionIndex, mode, handle = null) => {
    const rect = normalizeRegions(chunk.bbox)[regionIndex]
    if (!rect) return
    event.preventDefault()
    event.stopPropagation()
    onActiveChunkChange(chunk.chunk_index)
    setInteraction({
      chunkIndex: chunk.chunk_index,
      regionIndex,
      mode,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    })
  }

  useEffect(() => {
    if (!interaction || !pageWidth || !pageHeight) return undefined

    const onPointerMove = (event) => {
      const dx = (event.clientX - interaction.startX) / scale
      const dy = (event.clientY - interaction.startY) / scale
      const next = { ...interaction.rect }

      if (interaction.mode === 'move') {
        const width = next.x2 - next.x1
        const height = next.y2 - next.y1
        next.x1 += dx
        next.y1 += dy
        next.x2 = next.x1 + width
        next.y2 = next.y1 + height
      } else {
        if (interaction.handle.includes('w')) next.x1 += dx
        if (interaction.handle.includes('e')) next.x2 += dx
        if (interaction.handle.includes('n')) next.y1 += dy
        if (interaction.handle.includes('s')) next.y2 += dy
      }

      next.page = currentPage
      next.unit = 'pdf_points'
      setChunkRegion(interaction.chunkIndex, interaction.regionIndex, next)
    }

    const onPointerUp = () => setInteraction(null)

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [currentPage, interaction, pageHeight, pageWidth, scale, setChunkRegion])

  const pageRegions = chunks.flatMap((chunk) => (
    normalizeRegions(chunk.bbox)
      .map((region, regionIndex) => ({ chunk, region, regionIndex }))
      .filter(({ region }) => Number(region.page || chunk.page_number || 1) === currentPage)
  ))

  if (!docId && !pdfUrl) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-ak-fog/35">
        Select a document for PDF annotation
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center text-sm text-red-300/80">
        {error}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div
        className="h-11 px-4 flex items-center gap-2 shrink-0"
        style={{ borderBottom: '1px solid rgba(241,239,228,0.10)', background: '#3c3539' }}
      >
        <button
          onClick={() => setPdfPage((page) => Math.max(1, page - 1))}
          disabled={currentPage <= 1 || loading}
          className="btn-ghost p-1 disabled:opacity-30"
          title="Previous page"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-xs w-20 text-center text-ak-fog/45">
          {loading ? 'Loading...' : `${currentPage} / ${totalPages || '?'}`}
        </span>
        <button
          onClick={() => setPdfPage((page) => Math.min(totalPages || page, page + 1))}
          disabled={!totalPages || currentPage >= totalPages || loading}
          className="btn-ghost p-1 disabled:opacity-30"
          title="Next page"
        >
          <ChevronRight size={16} />
        </button>

        <div className="h-4 w-px mx-1" style={{ background: 'rgba(241,239,228,0.12)' }} />
        <button onClick={() => setScale((value) => Math.min(3, value + 0.15))} className="btn-ghost p-1" title="Zoom in">
          <ZoomIn size={15} />
        </button>
        <button onClick={() => setScale((value) => Math.max(0.65, value - 0.15))} className="btn-ghost p-1" title="Zoom out">
          <ZoomOut size={15} />
        </button>

        <div className="h-4 w-px mx-1" style={{ background: 'rgba(241,239,228,0.12)' }} />
        <button
          onClick={() => ensureActiveRect({ autoSearch: false })}
          disabled={!activeChunk || !viewport}
          className="btn h-8 px-3 flex items-center gap-2 text-xs disabled:opacity-40"
        >
          <Plus size={14} />
          Region
        </button>
        <button
          onClick={autoPlaceMissingRegions}
          disabled={!viewport || autoPlacing || chunks.length === 0}
          className="btn h-8 px-3 flex items-center gap-2 text-xs disabled:opacity-40"
          title="Automatically find PDF regions for chunks without annotation"
        >
          Auto
        </button>
        <button
          onClick={removeActiveRect}
          disabled={!canRemoveRegion}
          className="btn-ghost h-8 px-2 text-red-300 disabled:opacity-30"
          title="Delete region"
        >
          <Trash2 size={14} />
        </button>
        <span className="ml-auto text-xs text-ak-fog/35">
          {activeChunk ? `Chunk #${activeChunk.chunk_index} · regions: ${activeRegions.length}` : 'Select a chunk on the left'}
        </span>
        {autoStatus && (
          <span className="max-w-xs truncate text-xs text-green-200/70" title={autoStatus}>
            {autoStatus}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 select-none" style={{ background: '#1e1a1d' }}>
        <div style={{ width: 'fit-content', margin: '0 auto' }}>
          <div
            className="relative inline-block shadow-xl"
            style={{
              width: viewport?.width || undefined,
              height: viewport?.height || undefined,
              background: '#ffffff',
              isolation: 'isolate',
            }}
          >
            {viewport && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: '#ffffff', zIndex: 0 }}
              />
            )}
            <canvas ref={canvasRef} className="relative block" style={{ background: 'transparent', zIndex: 1 }} />

            {viewport && pageRegions.map(({ chunk, region, regionIndex }) => {
              const rect = normalizeRect(region)
              const isActive = chunk.chunk_index === activeChunkIndex
              const left = rect.x1 * scale
              const top = rect.y1 * scale
              const width = (rect.x2 - rect.x1) * scale
              const height = (rect.y2 - rect.y1) * scale

              return (
                <div
                  key={`${chunk.chunk_index}-${region.id || regionIndex}`}
                  onPointerDown={(event) => {
                    if (isActive) {
                      startInteraction(event, chunk, regionIndex, 'move')
                      return
                    }
                    event.stopPropagation()
                    onActiveChunkChange(chunk.chunk_index)
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    onActiveChunkChange(chunk.chunk_index)
                  }}
                  className="absolute"
                  style={{
                    left,
                    top,
                    width,
                    height,
                    zIndex: 2,
                    cursor: isActive ? 'move' : 'pointer',
                    outline: isActive ? '2px solid rgba(34,197,94,0.95)' : '2px solid rgba(251,191,36,0.72)',
                    background: isActive ? 'rgba(34,197,94,0.16)' : 'rgba(251,191,36,0.13)',
                    boxShadow: isActive ? '0 0 0 1px rgba(31,27,30,0.92)' : 'none',
                  }}
                >
                  <div
                    className="absolute -top-7 left-0 rounded px-2 py-1 text-[11px]"
                    style={{ background: 'rgba(31,27,30,0.92)', color: isActive ? '#86efac' : '#fde047' }}
                  >
                    Chunk #{chunk.chunk_index}
                  </div>

                  {isActive && (
                    <>
                      <Maximize2 size={14} className="absolute right-1 top-1 text-green-100/80 pointer-events-none" />
                      {Object.entries(HANDLE_STYLES).map(([handle, style]) => (
                        <span
                          key={handle}
                          onPointerDown={(event) => startInteraction(event, chunk, regionIndex, 'resize', handle)}
                          className="absolute block h-3 w-3 rounded-sm bg-green-300"
                          style={style}
                        />
                      ))}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
