import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import {
  CheckSquare,
  Download,
  FileText,
  Layers,
  Pilcrow,
  Save,
  Table2,
  Trash2,
  Upload,
} from 'lucide-react'
import api from './lib/api'
import PdfChunkHighlighter from './components/PdfChunkHighlighter'

const CHUNK_TYPE_LABELS = {
  text: 'Text',
  table: 'Table',
  equation: 'Equation',
}

function exportBaseName(fileName) {
  return (fileName || 'document').replace(/\.[^/.]+$/, '') || 'document'
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function bboxRegions(bbox) {
  if (!bbox) return []
  if (Array.isArray(bbox.regions)) return bbox.regions
  return [bbox]
}

function bboxStatus(bbox) {
  const regions = bboxRegions(bbox)
  if (regions.length === 0) return 'PDF region: none'
  if (regions.length === 1) return `PDF region: page ${regions[0].page || 1}`
  const pages = [...new Set(regions.map((region) => region.page || 1))].join(', ')
  return `PDF regions: ${regions.length}; pages ${pages}`
}

function BlockIcon({ type, role }) {
  if (type === 'table') return <Table2 size={15} className="text-ak-fog/45" />
  if (role === 'heading') return <Layers size={15} className="text-ak-fog/45" />
  return <Pilcrow size={15} className="text-ak-fog/35" />
}

function DocxTable({ rows }) {
  if (!rows?.length) return null

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => {
                const Cell = rowIndex === 0 ? 'th' : 'td'
                return (
                  <Cell
                    key={`${rowIndex}-${cellIndex}`}
                    className="px-3 py-2 text-left align-top"
                    style={{
                      border: '1px solid rgba(241,239,228,0.16)',
                      background: rowIndex === 0 ? 'rgba(241,239,228,0.08)' : 'transparent',
                    }}
                  >
                    {cell || ' '}
                  </Cell>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocumentBlock({ block, selected, assignedChunk, onToggle }) {
  const disabled = assignedChunk !== undefined
  const isHeading = block.role === 'heading'
  const isTable = block.type === 'table'

  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onToggle(block.id)
      }}
      disabled={disabled}
      className="w-full text-left transition-colors disabled:cursor-default"
      style={{
        padding: isTable ? '14px' : '10px 14px',
        borderLeft: assignedChunk !== undefined
          ? '3px solid rgba(34,197,94,0.72)'
          : selected
            ? '3px solid rgba(241,239,228,0.82)'
            : '3px solid transparent',
        borderBottom: '1px solid rgba(241,239,228,0.07)',
        background: assignedChunk !== undefined
          ? 'rgba(34,197,94,0.08)'
          : selected
            ? 'rgba(241,239,228,0.08)'
            : 'transparent',
        opacity: disabled ? 0.72 : 1,
      }}
    >
      <div className="flex items-start gap-2">
        <div className="flex w-6 shrink-0 justify-center pt-1">
          <BlockIcon type={block.type} role={block.role} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] text-ak-fog/30">#{block.id}</span>
            {block.page_number && <span className="text-[11px] text-ak-fog/30">p. {block.page_number}</span>}
            {isTable && <span className="text-[11px] text-ak-fog/45">table</span>}
            {assignedChunk !== undefined && (
              <span className="text-[11px] text-green-200/75">chunk #{assignedChunk}</span>
            )}
          </div>

          {isTable ? (
            <>
              <div className="mb-3 text-sm font-medium text-ak-fog/80">
                {block.table_title || 'Table'}
              </div>
              <DocxTable rows={block.rows} />
            </>
          ) : (
            <p className={isHeading ? 'text-base font-semibold text-ak-fog/90' : 'text-sm leading-relaxed text-ak-fog/80'}>
              {block.text}
            </p>
          )}
        </div>
      </div>
    </button>
  )
}

export default function App() {
  const [fileName, setFileName] = useState('')
  const [previewId, setPreviewId] = useState('')
  const [previewPdfUrl, setPreviewPdfUrl] = useState('')
  const [previewPdfError, setPreviewPdfError] = useState('')
  const [blocks, setBlocks] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [chunks, setChunks] = useState([])
  const [activeChunkIndex, setActiveChunkIndex] = useState(null)
  const [previewMode, setPreviewMode] = useState('docx')
  const [chunkType, setChunkType] = useState('text')
  const [sectionTitle, setSectionTitle] = useState('')
  const [tableTitle, setTableTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)

  const stats = useMemo(() => ({
    tables: blocks.filter((block) => block.type === 'table').length,
    paragraphs: blocks.filter((block) => block.type === 'paragraph').length,
  }), [blocks])

  const selectedBlocks = useMemo(() => (
    blocks
      .filter((block) => selectedIds.includes(block.id))
      .sort((a, b) => a.id - b.id)
  ), [blocks, selectedIds])

  const assignedByBlockId = useMemo(() => {
    const result = new Map()
    chunks.forEach((chunk) => {
      chunk.block_ids?.forEach((blockId) => result.set(blockId, chunk.chunk_index))
    })
    return result
  }, [chunks])

  const resetDocument = () => {
    setPreviewId('')
    setPreviewPdfUrl('')
    setPreviewPdfError('')
    setBlocks([])
    setSelectedIds([])
    setChunks([])
    setActiveChunkIndex(null)
    setPreviewMode('docx')
  }

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setLoading(true)
    resetDocument()
    setFileName(file.name)

    try {
      const form = new FormData()
      form.append('file', file)
      const { data } = await api.post('/docx-preview', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setBlocks(data.blocks || [])
      setPreviewId(data.preview_id || '')
      setPreviewPdfUrl(data.pdf_url || '')
      setPreviewPdfError(data.pdf_error || '')
      toast.success(data.pdf_ready ? 'DOCX opened, PDF ready' : 'DOCX opened')
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to open DOCX')
    } finally {
      setLoading(false)
      event.target.value = ''
    }
  }

  const toggleBlock = (blockId) => {
    if (assignedByBlockId.has(blockId)) {
      toast.error(`Block already belongs to chunk #${assignedByBlockId.get(blockId)}`)
      return
    }
    setSelectedIds((prev) => (
      prev.includes(blockId)
        ? prev.filter((id) => id !== blockId)
        : [...prev, blockId].sort((a, b) => a - b)
    ))
  }

  const createChunk = () => {
    if (!selectedBlocks.length) {
      toast.error('Select blocks first')
      return
    }

    const conflict = selectedBlocks.find((block) => assignedByBlockId.has(block.id))
    if (conflict) {
      toast.error(`Block #${conflict.id} already belongs to chunk #${assignedByBlockId.get(conflict.id)}`)
      return
    }

    const section = (sectionTitle || selectedBlocks[0]?.section_title || '').trim()
    const title = (tableTitle || selectedBlocks.find((block) => block.table_title)?.table_title || '').trim()
    const text = selectedBlocks.map((block) => block.text).join('\n\n').trim()
    const nextIndex = chunks.length
    const nextChunk = {
      chunk_index: nextIndex,
      chunk_type: chunkType,
      section_title: section || null,
      table_title: chunkType === 'table' ? title || null : null,
      table_number: selectedBlocks.find((block) => block.table_number)?.table_number || null,
      page_number: selectedBlocks[0]?.page_number || null,
      text,
      bbox: null,
      block_ids: selectedBlocks.map((block) => block.id),
    }

    setChunks((prev) => [...prev, nextChunk])
    setSelectedIds([])
    setActiveChunkIndex(nextIndex)
    toast.success(`Chunk #${nextIndex} created`)
  }

  const deleteChunk = (chunkIndex) => {
    setChunks((prev) => (
      prev
        .filter((chunk) => chunk.chunk_index !== chunkIndex)
        .map((chunk, index) => ({ ...chunk, chunk_index: index }))
    ))
    setActiveChunkIndex(null)
  }

  const updateChunkGeometry = (chunkIndex, updates) => {
    setChunks((prev) => prev.map((chunk) => (
      chunk.chunk_index === chunkIndex ? { ...chunk, ...updates } : chunk
    )))
  }

  const exportJson = async () => {
    if (!chunks.length) {
      toast.error('No chunks to export')
      return
    }

    const baseName = exportBaseName(fileName)
    const pdfFileName = `${baseName}-preview.pdf`
    const payload = {
      filename: fileName,
      preview_id: previewId || null,
      pdf_preview: previewPdfUrl || null,
      pdf_file: previewPdfUrl ? pdfFileName : null,
      chunks,
    }
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `${baseName}-manual-chunks.json`,
    )

    if (!previewPdfUrl) {
      toast.success('JSON exported. PDF is not available')
      return
    }

    setExporting(true)
    try {
      const { data } = await api.get(previewPdfUrl, { responseType: 'blob' })
      const pdfBlob = data instanceof Blob ? data : new Blob([data], { type: 'application/pdf' })
      downloadBlob(pdfBlob, pdfFileName)
      toast.success('JSON and PDF exported')
    } catch (err) {
      toast.error(err.response?.data?.detail || 'JSON exported, PDF download failed')
    } finally {
      setExporting(false)
    }
  }

  const saveAnnotation = async () => {
    if (!previewId) {
      toast.error('Open a DOCX first')
      return
    }
    if (!chunks.length) {
      toast.error('No chunks to save')
      return
    }

    setSaving(true)
    try {
      const { data } = await api.post(`/docx-preview/${previewId}/save`, {
        filename: fileName,
        chunks,
      })
      toast.success(`Saved ${data.chunks_saved} chunks${data.pdf_saved ? ' and PDF' : ''}`)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full overflow-hidden bg-ak-bg">
      <aside
        className="flex w-[390px] shrink-0 flex-col bg-ak-surface"
        style={{ borderRight: '1px solid rgba(241,239,228,0.12)' }}
      >
        <div className="p-4" style={{ borderBottom: '1px solid rgba(241,239,228,0.10)' }}>
          <div className="mb-4 flex items-center gap-2">
            <FileText size={18} className="text-ak-fog/65" />
            <h1 className="text-base font-semibold text-ak-fog/90">DOCX/PDF Chunk Annotator</h1>
          </div>

          <label className="btn-primary flex h-10 w-full cursor-pointer items-center gap-2">
            <Upload size={16} />
            {loading ? 'Opening...' : 'Open DOCX'}
            <input type="file" accept=".docx" onChange={handleFile} className="hidden" />
          </label>

          {fileName && (
            <div className="mt-3 truncate text-xs text-ak-fog/50" title={fileName}>
              {fileName}
            </div>
          )}

          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label="Blocks" value={blocks.length} />
            <Stat label="Tables" value={stats.tables} />
            <Stat label="Chunks" value={chunks.length} />
          </div>
        </div>

        <div className="space-y-3 p-4" style={{ borderBottom: '1px solid rgba(241,239,228,0.10)' }}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1.5 block text-xs text-ak-fog/45">Type</label>
              <select value={chunkType} onChange={(e) => setChunkType(e.target.value)} className="input">
                <option value="text">Text</option>
                <option value="table">Table</option>
                <option value="equation">Equation</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-ak-fog/45">Section</label>
              <input
                value={sectionTitle}
                onChange={(e) => setSectionTitle(e.target.value)}
                placeholder={selectedBlocks[0]?.section_title || 'Auto'}
                className="input"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-ak-fog/45">Table title</label>
            <input
              value={tableTitle}
              onChange={(e) => setTableTitle(e.target.value)}
              placeholder={selectedBlocks[0]?.table_title || 'For table chunks'}
              className="input"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button onClick={createChunk} className="btn-primary h-10 gap-2">
              <CheckSquare size={16} />
              Chunk ({selectedIds.length})
            </button>
            <button onClick={exportJson} disabled={exporting} className="btn-ghost h-10 gap-2">
              <Download size={16} />
              {exporting ? '...' : 'JSON+PDF'}
            </button>
            <button onClick={saveAnnotation} disabled={saving} className="btn-ghost h-10 gap-2">
              <Save size={16} />
              {saving ? '...' : 'Save'}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {chunks.map((chunk) => (
            <button
              type="button"
              key={chunk.chunk_index}
              onClick={() => {
                setActiveChunkIndex(chunk.chunk_index)
                setPreviewMode('pdf')
              }}
              className="w-full p-3 text-left transition-colors hover:bg-ak-fog/5"
              style={{
                borderBottom: '1px solid rgba(241,239,228,0.08)',
                background: activeChunkIndex === chunk.chunk_index ? 'rgba(241,239,228,0.07)' : 'transparent',
              }}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs text-ak-fog/45">#{chunk.chunk_index}</span>
                <span className="text-xs text-ak-fog/65">{CHUNK_TYPE_LABELS[chunk.chunk_type] || chunk.chunk_type}</span>
                <Trash2
                  size={14}
                  className="ml-auto text-red-200/75"
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteChunk(chunk.chunk_index)
                  }}
                />
              </div>
              <div className="mb-1 text-xs text-ak-fog/45">{chunk.section_title || 'No section'}</div>
              <div className="mb-1 text-xs text-green-200/70">{bboxStatus(chunk.bbox)}</div>
              <p className="line-clamp-4 text-xs leading-relaxed text-ak-fog/70">
                {chunk.text}
              </p>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-12 shrink-0 items-center gap-3 px-5"
          style={{ borderBottom: '1px solid rgba(241,239,228,0.10)', background: '#352f33' }}
        >
          <button
            onClick={() => setPreviewMode('docx')}
            className={`btn-ghost h-8 px-3 ${previewMode === 'docx' ? 'text-ak-gold' : 'text-ak-fog/70'}`}
          >
            DOCX
          </button>
          <button
            onClick={() => setPreviewMode('pdf')}
            className={`btn-ghost h-8 px-3 ${previewMode === 'pdf' ? 'text-ak-gold' : 'text-ak-fog/70'}`}
          >
            PDF
          </button>
          <span className="ml-auto text-xs text-ak-fog/40">
            Selected blocks: {selectedIds.length}
          </span>
        </div>

        {previewMode === 'docx' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto max-w-5xl overflow-hidden rounded-md" style={{ border: '1px solid rgba(241,239,228,0.10)' }}>
              {blocks.length === 0 ? (
                <div className="flex h-[420px] items-center justify-center text-sm text-ak-fog/40">
                  Open a DOCX file to start annotation
                </div>
              ) : (
                blocks.map((block) => (
                  <DocumentBlock
                    key={block.id}
                    block={block}
                    selected={selectedIds.includes(block.id)}
                    assignedChunk={assignedByBlockId.get(block.id)}
                    onToggle={toggleBlock}
                  />
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            {previewPdfUrl ? (
              <PdfChunkHighlighter
                docId={null}
                pdfUrl={previewPdfUrl}
                chunks={chunks}
                activeChunkIndex={activeChunkIndex}
                onActiveChunkChange={setActiveChunkIndex}
                onChunkGeometryChange={updateChunkGeometry}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-8 text-center text-sm text-ak-fog/45">
                {previewPdfError || 'PDF preview is not available yet'}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md px-2 py-2" style={{ background: 'rgba(241,239,228,0.06)' }}>
      <div className="text-[11px] text-ak-fog/40">{label}</div>
      <div className="text-sm text-ak-fog/80">{value}</div>
    </div>
  )
}

