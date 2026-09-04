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
  const platformSteps = ['login', 'team', 'agent', 'assets'] as const;
  const clientSteps = ['apiKey', 'install', 'upgrade', 'uninstall', 'binding'] as const;
  const roleCards = ['systemAdmin', 'teamAdmin', 'member'] as const;
  const defaultAgentCards = ['trigger', 'template', 'fallback', 'backfill'] as const;
  const publicSkillCards = ['core', 'policy', 'existing', 'conflict'] as const;
  const operationCards = ['apiKey', 'async', 'delete', 'wikiMcp'] as const;
  const assetCards = [
    { label: 'Wiki / RAG', key: 'wiki' },
    { label: 'CodeGraph', key: 'code' },
    { label: 'Skill', key: 'skill' },
    { label: 'Chat Memory', key: 'memory' },
  ] as const;

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

      <section className="guide-surface guide-section guide-section--platform">
        <header className="guide-section-heading">
          <span className="guide-section-index">01</span>
          <div>
            <h2>{t('guide.platform.title')}</h2>
            <p>{t('guide.platform.desc')}</p>
          </div>
        </header>

        <ol className="guide-stepper">
          {platformSteps.map((step, index) => (
            <li key={step} className="done">
              <div className="guide-command secondary">
                <span className="guide-stepper-badge">{index + 1}</span>
                <span className="guide-stepper-meta">
                  <b>{t(`guide.platform.${step}.title`)}</b>
                  <small>{t(`guide.platform.${step}.desc`)}</small>
                </span>
              </div>
            </li>
          ))}
        </ol>

        <h3 className="guide-subheading">{t('guide.roles.title')}</h3>
        <div className="guide-practice-rules">
          {roleCards.map((role) => (
            <p key={role}>
              <b>{t(`guide.roles.${role}.title`)}</b>
              {t(`guide.roles.${role}.desc`)}
            </p>
          ))}
        </div>

        <h3 className="guide-subheading guide-subheading--spaced">
          {t('guide.defaultAgent.title')}
        </h3>
        <div className="guide-practice-rules guide-practice-rules--four">
          {defaultAgentCards.map((item) => (
            <p key={item}>
              <b>{t(`guide.defaultAgent.${item}.title`)}</b>
              {t(`guide.defaultAgent.${item}.desc`)}
            </p>
          ))}
        </div>

        <h3 className="guide-subheading guide-subheading--spaced">
          {t('guide.publicSkill.title')}
        </h3>
        <div className="guide-practice-rules guide-practice-rules--four">
          {publicSkillCards.map((item) => (
            <p key={item}>
              <b>{t(`guide.publicSkill.${item}.title`)}</b>
              {t(`guide.publicSkill.${item}.desc`)}
            </p>
          ))}
        </div>

        <h3 className="guide-subheading">{t('guide.platform.assets.detailTitle')}</h3>
        <div className="guide-practice-rules guide-practice-rules--four">
          {assetCards.map((asset) => (
            <p key={asset.key}>
              <b>{asset.label}</b>
              {t(`guide.assets.${asset.key}`)}
            </p>
          ))}
        </div>
        <h3 className="guide-subheading guide-subheading--spaced">
          {t('guide.operations.title')}
        </h3>
        <div className="guide-practice-rules guide-practice-rules--four">
          {operationCards.map((item) => (
            <p key={item}>
              <b>{t(`guide.operations.${item}.title`)}</b>
              {t(`guide.operations.${item}.desc`)}
            </p>
          ))}
        </div>
        <div className="guide-practice-links">
          <span>{t('guide.cbrain.open')}</span>
          <button type="button" onClick={() => navigate('/team/members')}>
            {t('guide.platform.members')}
          </button>
          <button type="button" onClick={() => navigate('/team/agents')}>
            Agent
          </button>
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

      <section className="guide-surface guide-section guide-section--client">
        <header className="guide-section-heading">
          <span className="guide-section-index">02</span>
          <div>
            <h2>{t('guide.client.title')}</h2>
            <p>{t('guide.client.desc')}</p>
          </div>
        </header>

        <div className="guide-prepare">
          <div className="guide-prepare-row">
            <b>{t('guide.cbrain.architecture')}</b>
            <span>{t('guide.cbrain.directModel')}</span>
          </div>
          <div className="guide-prepare-row">
            <b>{t('guide.client.apiKey.title')}</b>
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

        <ol className="guide-stepper guide-stepper--five">
          {clientSteps.map((step, index) => (
            <li key={step} className="done">
              <div className="guide-command secondary">
                <span className="guide-stepper-badge">{index + 1}</span>
                <span className="guide-stepper-meta">
                  <b>{t(`guide.client.${step}.title`)}</b>
                  <small>{t(`guide.client.${step}.desc`)}</small>
                </span>
              </div>
            </li>
          ))}
        </ol>

        <h2>{t('guide.cbrain.installTitle')}</h2>
        <p className="guide-run-hint">{t('guide.cbrain.installHint')}</p>
        {clients.flatMap((client) => {
          const installCommand = gatewayUrl
            ? buildCbrainAgentCommand({
                action: 'install',
                client: client.id,
                origin: window.location.origin,
                gatewayUrl,
              })
            : '';
          const uninstallCommand = buildCbrainAgentCommand({
            action: 'uninstall',
            client: client.id,
            origin: window.location.origin,
          });
          return [
            { key: `${client.id}-install`, command: installCommand, hint: 'guide.cbrain.installOrUpdate' },
            { key: `${client.id}-uninstall`, command: uninstallCommand, hint: 'guide.cbrain.uninstall' },
          ].map((item) => (
            <div key={item.key} className="guide-code-card" style={{ marginTop: 12 }}>
              <header>
                <div>
                  <h3>{client.label}</h3>
                  <p>{t(item.hint)}</p>
                </div>
                {item.command ? <CopyButton value={item.command} /> : null}
              </header>
              <pre>{item.command || t('guide.cbrain.gatewayLoading')}</pre>
            </div>
          ));
        })}

        <h3 className="guide-subheading guide-subheading--spaced">
          {t('guide.client.binding.title')}
        </h3>
        <div className="guide-practice-rules">
          <p>{t('guide.client.binding.desc')}</p>
          <p>{t('guide.client.binding.reuse')}</p>
          <p>{t('guide.client.binding.change')}</p>
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
