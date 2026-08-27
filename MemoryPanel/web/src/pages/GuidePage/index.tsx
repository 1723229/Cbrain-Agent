import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { metaInstancesApi } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import { tea } from '@/lib/tea-bridge';
import { buildCbrainAgentCommand } from '@/pages/ApiKeysPage/components/plugin-install-command';
import './style.css';

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="guide-copy"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => tea.notify.error(t('guide.copyFailed')));
      }}
    >
      {copied ? t('guide.copied') : t('guide.copy')}
    </button>
  );
}

export function GuidePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [gatewayUrl, setGatewayUrl] = useState('');
  const session = getPanelSession();

  useEffect(() => {
    let active = true;
    void metaInstancesApi
      .list()
      .then((instances) => {
        if (!active) return;
        const current = instances.find((instance) => instance.instance_id === session?.instanceId);
        setGatewayUrl(current?.agent_gateway_endpoint ?? '');
      })
      .catch(() => {
        if (active) setGatewayUrl('');
      });
    return () => {
      active = false;
    };
  }, [session?.instanceId]);

  const clients = [
    { id: 'codex' as const, label: 'Codex' },
    { id: 'claude-code' as const, label: 'Claude Code' },
  ];

  return (
    <div className="guide-page">
      <header className="guide-titlebar">
        <div>
          <button type="button" className="guide-back" onClick={() => navigate('/team/agents')}>
            ← {t('guide.cbrain.back')}
          </button>
          <h1>{t('guide.cbrain.title')}</h1>
          <p>{t('guide.cbrain.subtitle')}</p>
        </div>
        <span className="guide-brand">Cbrain</span>
      </header>

      <section className="guide-surface" style={{ marginTop: 16 }}>
        <div className="guide-prepare">
          <div className="guide-prepare-row">
            <b>{t('guide.cbrain.architecture')}</b>
            <span>{t('guide.cbrain.directModel')}</span>
          </div>
          <div className="guide-prepare-row">
            <b>{t('guide.cbrain.auth')}</b>
            <button
              type="button"
              className="guide-key-link"
              onClick={() => navigate('/team/api-keys')}
            >
              {t('guide.cbrain.openApiKeys')} →
            </button>
          </div>
          <div className="guide-prepare-row">
            <b>Gateway</b>
            <code className="guide-prepare-value">
              {gatewayUrl || t('guide.cbrain.gatewayLoading')}
            </code>
          </div>
        </div>

        <ol className="guide-stepper">
          {[1, 2, 3, 4].map((step) => (
            <li key={step} className="done">
              <div className="guide-command secondary">
                <span className="guide-stepper-badge">{step}</span>
                <span className="guide-stepper-meta">
                  <b>{t(`guide.cbrain.step${step}.title`)}</b>
                  <small>{t(`guide.cbrain.step${step}.desc`)}</small>
                </span>
              </div>
            </li>
          ))}
        </ol>

        <h2>{t('guide.cbrain.installTitle')}</h2>
        <p className="guide-run-hint">{t('guide.cbrain.installHint')}</p>
        {clients.map((client) => {
          const command = gatewayUrl
            ? buildCbrainAgentCommand({
                action: 'install',
                client: client.id,
                origin: window.location.origin,
                gatewayUrl,
              })
            : '';
          return (
            <div key={client.id} className="guide-code-card" style={{ marginTop: 12 }}>
              <header>
                <div>
                  <h3>{client.label}</h3>
                  <p>{t('guide.cbrain.installOrUpdate')}</p>
                </div>
                {command ? <CopyButton value={command} /> : null}
              </header>
              <pre>{command || t('guide.cbrain.gatewayLoading')}</pre>
            </div>
          );
        })}
      </section>

      <section className="guide-surface guide-practice" style={{ marginTop: 16 }}>
        <h2>{t('guide.cbrain.assetsTitle')}</h2>
        <div className="guide-practice-rules">
          <p>
            <b>Wiki / RAG</b>
            {t('guide.cbrain.wiki')}
          </p>
          <p>
            <b>CodeGraph</b>
            {t('guide.cbrain.code')}
          </p>
          <p>
            <b>Public Skills</b>
            {t('guide.cbrain.skills')}
          </p>
        </div>
        <div className="guide-practice-links" style={{ marginTop: 16 }}>
          <span>{t('guide.cbrain.open')}</span>
          <button type="button" onClick={() => navigate('/wiki')}>
            Wiki
          </button>
          <button type="button" onClick={() => navigate('/code')}>
            CodeGraph
          </button>
          <button type="button" onClick={() => navigate('/skills')}>
            Skill
          </button>
          <button type="button" onClick={() => navigate('/memory')}>
            Chat Memory
          </button>
        </div>
      </section>

      <section className="guide-replay">
        <div>
          <h3>{t('guide.replay.title')}</h3>
          <p>{t('guide.replay.desc')}</p>
        </div>
        <button
          type="button"
          className="guide-replay-btn"
          onClick={() => window.dispatchEvent(new CustomEvent('tdai-replay-onboarding'))}
        >
          {t('guide.replay.button')}
        </button>
      </section>
    </div>
  );
}
