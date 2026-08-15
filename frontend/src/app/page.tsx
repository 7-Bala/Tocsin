import React from 'react';
import Link from 'next/link';

export default function Home() {
  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '1.5rem',
      }}
    >
      <header
        style={{
          width: '100%',
          maxWidth: '840px',
          margin: '0 auto',
        }}
      >
        <section
          style={{
            padding: '2.5rem 2rem',
            borderRadius: '16px',
            border: '1px solid var(--border)',
            backgroundColor: 'var(--card-bg)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.45)',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              display: 'inline-block',
              padding: '0.35rem 0.85rem',
              borderRadius: '9999px',
              backgroundColor: 'rgba(248, 81, 73, 0.15)',
              color: 'var(--accent-red)',
              fontSize: '0.875rem',
              fontWeight: 600,
              marginBottom: '1.25rem',
              border: '1px solid rgba(248, 81, 73, 0.35)',
            }}
          >
            EchoSphere Hackathon • Team KNOTiC
          </div>

          <h1
            style={{
              fontSize: 'clamp(2.25rem, 6vw, 3.5rem)',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              marginBottom: '1rem',
              color: 'var(--text-primary)',
            }}
          >
            TOCSIN
          </h1>

          <p
            style={{
              fontSize: 'clamp(1rem, 2.5vw, 1.25rem)',
              color: 'var(--text-secondary)',
              lineHeight: '1.6',
              maxWidth: '680px',
              margin: '0 auto 2rem auto',
            }}
          >
            Real-time voice AI disaster-coordination platform. Listens to
            fragmented multilingual voice streams, maintains live incident state,
            calls verified tools, and coordinates emergency response.
          </p>

          <div
            style={{
              marginBottom: '2.5rem',
              display: 'flex',
              justifyContent: 'center',
              gap: '1rem',
            }}
          >
            <Link
              href="/voice-test"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.85rem 1.75rem',
                borderRadius: '10px',
                backgroundColor: 'var(--accent-blue)',
                color: '#fff',
                fontWeight: 600,
                textDecoration: 'none',
                boxShadow: '0 4px 14px 0 rgba(88, 166, 255, 0.35)',
              }}
            >
              🎙 Launch Agora Voice Test
            </Link>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '1rem',
              textAlign: 'left',
            }}
          >
            <article
              style={{
                padding: '1.25rem',
                borderRadius: '10px',
                border: '1px solid var(--border)',
                background: 'rgba(0, 0, 0, 0.25)',
              }}
            >
              <h2
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  color: 'var(--text-secondary)',
                  marginBottom: '0.5rem',
                }}
              >
                FRONTEND
              </h2>
              <p
                style={{
                  fontWeight: 600,
                  color: 'var(--accent-green)',
                  fontSize: '0.95rem',
                }}
              >
                Next.js 14 + Agora Web SDK
              </p>
            </article>

            <article
              style={{
                padding: '1.25rem',
                borderRadius: '10px',
                border: '1px solid var(--border)',
                background: 'rgba(0, 0, 0, 0.25)',
              }}
            >
              <h2
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  color: 'var(--text-secondary)',
                  marginBottom: '0.5rem',
                }}
              >
                BACKEND
              </h2>
              <p
                style={{
                  fontWeight: 600,
                  color: 'var(--accent-blue)',
                  fontSize: '0.95rem',
                }}
              >
                FastAPI + Agora Token Engine
              </p>
            </article>

            <article
              style={{
                padding: '1.25rem',
                borderRadius: '10px',
                border: '1px solid var(--border)',
                background: 'rgba(0, 0, 0, 0.25)',
              }}
            >
              <h2
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  color: 'var(--text-secondary)',
                  marginBottom: '0.5rem',
                }}
              >
                MOCK SERVICES
              </h2>
              <p
                style={{
                  fontWeight: 600,
                  color: 'var(--accent-red)',
                  fontSize: '0.95rem',
                }}
              >
                FastMCP Server (6 Tools)
              </p>
            </article>
          </div>
        </section>
      </header>

      <footer
        style={{
          marginTop: '2rem',
          fontSize: '0.85rem',
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        Tocsin Crisis Coordination Engine • Milestone 4 Voice POC Ready
      </footer>
    </main>
  );
}
