'use client';

import React, { useEffect, useRef, useState } from 'react';
import { FinalizedUtterance, ActivePartialUtterance } from '@/lib/utteranceManager';
import { FileTextIcon, CheckIcon, ClipboardIcon } from '@/components/Icon';

interface LiveTranscriptPanelProps {
  items?: FinalizedUtterance[];
  activePartial?: ActivePartialUtterance | null;
  onClear?: () => void;
}

export const LiveTranscriptPanel: React.FC<LiveTranscriptPanelProps> = ({
  items = [],
  activePartial = null,
  onClear,
}) => {
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new finalized utterances or active streaming speech
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items, activePartial, autoScroll]);

  // Copy finalized transcript for the current live session only
  const handleCopy = async () => {
    if (items.length === 0) return;

    const lines = items.map(
      (item) => `[${item.timeStr}] ${item.speaker}: ${item.text}`
    );

    const plainText = lines.join('\n');
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback copy using textarea
      const el = document.createElement('textarea');
      el.value = plainText;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      style={{
        padding: '1.25rem',
        borderRadius: '12px',
        border: '1px solid var(--border)',
        backgroundColor: '#070b14',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        width: '100%',
      }}
    >
      {/* Header & Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          paddingBottom: '0.65rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span
            style={{
              fontSize: '0.85rem',
              fontWeight: 800,
              letterSpacing: '0.04em',
              color: 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <FileTextIcon /> LIVE TRANSCRIPT
          </span>
          <span
            style={{
              padding: '0.15rem 0.5rem',
              borderRadius: '9999px',
              fontSize: '0.72rem',
              fontWeight: 700,
              backgroundColor: 'rgba(88, 166, 255, 0.12)',
              color: 'var(--accent-blue)',
              border: '1px solid rgba(88, 166, 255, 0.25)',
            }}
          >
            {items.length} {items.length === 1 ? 'utterance' : 'utterances'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            onClick={handleCopy}
            disabled={items.length === 0}
            style={{
              padding: '0.35rem 0.75rem',
              borderRadius: '6px',
              fontSize: '0.75rem',
              fontWeight: 700,
              border: '1px solid var(--border)',
              backgroundColor: copied
                ? 'rgba(63, 185, 80, 0.25)'
                : 'rgba(255, 255, 255, 0.06)',
              color: copied ? 'var(--accent-green)' : 'var(--text-primary)',
              cursor: items.length === 0 ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              transition: 'all 0.15s ease',
            }}
            title="Copy clean finalized conversation transcript as plain text"
          >
            {copied ? (<><CheckIcon /> Copied to Clipboard!</>) : (<><ClipboardIcon /> Copy Transcript</>)}
          </button>

          {items.length > 0 && onClear && (
            <button
              type="button"
              onClick={onClear}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                fontSize: '0.75rem',
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: '0.2rem 0.4rem',
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Transcript Scroll Area */}
      <div
        ref={scrollRef}
        onScroll={() => {
          if (!scrollRef.current) return;
          const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
          const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
          setAutoScroll(isAtBottom);
        }}
        style={{
          maxHeight: '260px',
          minHeight: '140px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          padding: '0.5rem 0.25rem',
          fontFamily: 'monospace',
          fontSize: '0.84rem',
        }}
      >
        {items.length === 0 && !activePartial ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '120px',
              color: 'var(--text-secondary)',
              fontSize: '0.8rem',
              fontStyle: 'italic',
              textAlign: 'center',
            }}
          >
            <div>No transcript entries for this session.</div>
            <div style={{ fontSize: '0.72rem', marginTop: '0.25rem', opacity: 0.7 }}>
              Speak or ask Gemini a question to begin real-time transcription.
            </div>
          </div>
        ) : (
          items.map((item) => {
            const isAgent = item.speaker === 'TOCSIN';

            return (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  lineHeight: '1.45',
                  padding: '0.35rem 0.5rem',
                  borderRadius: '6px',
                  backgroundColor: isAgent
                    ? 'rgba(63, 185, 80, 0.06)'
                    : 'rgba(88, 166, 255, 0.06)',
                  borderLeft: `3px solid ${
                    isAgent ? 'var(--accent-green)' : 'var(--accent-blue)'
                  }`,
                }}
              >
                {/* Timestamp */}
                <span
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: '0.75rem',
                    flexShrink: 0,
                    paddingTop: '0.1rem',
                  }}
                >
                  [{item.timeStr}]
                </span>

                {/* Speaker Label */}
                <span
                  style={{
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                    fontSize: '0.72rem',
                    fontWeight: 800,
                    flexShrink: 0,
                    letterSpacing: '0.02em',
                    backgroundColor: isAgent
                      ? 'rgba(63, 185, 80, 0.2)'
                      : 'rgba(88, 166, 255, 0.2)',
                    color: isAgent
                      ? 'var(--accent-green)'
                      : 'var(--accent-blue)',
                  }}
                >
                  {item.speaker}
                </span>

                {/* Clean Finalized Message Text */}
                <span
                  style={{
                    color: isAgent ? '#ffffff' : '#e6edf3',
                    wordBreak: 'break-word',
                    flex: 1,
                  }}
                >
                  {item.text}
                </span>
              </div>
            );
          })
        )}

        {/* Real-time Streaming Partial Utterance (Updates in-place, not appended) */}
        {activePartial && activePartial.text.trim() && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.5rem',
              lineHeight: '1.45',
              padding: '0.35rem 0.5rem',
              borderRadius: '6px',
              backgroundColor: 'rgba(255, 255, 255, 0.04)',
              borderLeft: '3px dashed var(--accent-blue)',
              opacity: 0.9,
            }}
          >
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', flexShrink: 0 }}>
              [{new Date().toLocaleTimeString()}]
            </span>
            <span
              style={{
                padding: '0.1rem 0.4rem',
                borderRadius: '4px',
                fontSize: '0.72rem',
                fontWeight: 800,
                backgroundColor: activePartial.speaker === 'TOCSIN'
                  ? 'rgba(63, 185, 80, 0.2)'
                  : 'rgba(88, 166, 255, 0.2)',
                color: activePartial.speaker === 'TOCSIN'
                  ? 'var(--accent-green)'
                  : 'var(--accent-blue)',
                flexShrink: 0,
              }}
            >
              {activePartial.speaker}
            </span>
            <span style={{ color: 'var(--text-primary)', fontStyle: 'italic', wordBreak: 'break-word', flex: 1 }}>
              {activePartial.text}
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '12px',
                  backgroundColor: 'var(--accent-blue)',
                  marginLeft: '4px',
                  verticalAlign: 'middle',
                  animation: 'pulse 1s infinite',
                }}
              />
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
