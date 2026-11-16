/**
 * UI Kit work item action "Request a custom field": checks the kill switch first, tells non-admins who decides, and
 * hands the request to Field Assistant in Rovo. Shows a "temporarily unavailable" or "changes are paused" message
 * with a link to the status page when SUPERPORT has paused the app, and no Field Assistant while the AI features are off.
 *
 * @file        src/frontend/issue.jsx
 * @app         Custom Field Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-16
 */

import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Stack, Text, Button, ButtonGroup, SectionMessage, Spinner, TextArea, Label, useProductContext } from '@forge/react';
import { invoke, rovo, router, view } from '@forge/bridge';

// Work item action "Request a custom field": describe the need, Field Assistant takes it from there. Everyone with
// access can use it: requests of users who are not project admins go to the project's admins first.
const PATH = { service_desk: 'servicedesk', software: 'software', business: 'core' };
// Public status page of SUPERPORT's apps (the server's 'availability' answer names it too).
const STATUS_PAGE_URL = 'https://superapps.statuspage.io';
// The kill switch's words, the same as on the settings page (static/main/src/Maintenance.jsx and i18n.de.js).
const APP_NAME = 'Custom Field Self-Service for Jira';
const MAINTENANCE_TEXT = {
  en: {
    title: `${APP_NAME} is temporarily unavailable`,
    body: `We've paused ${APP_NAME} for maintenance to keep your data safe. Nothing you've saved is lost, and we'll be back as soon as possible. You can follow the progress on our status page.`,
    button: 'View status page',
    readonly: 'Changes are paused for maintenance to keep your data safe. You can still view everything; editing will be back as soon as possible.',
  },
  de: {
    title: `${APP_NAME} ist vorübergehend nicht verfügbar`,
    body: `Wir haben ${APP_NAME} zu deinem Schutz für Wartungsarbeiten pausiert. Deine gespeicherten Daten bleiben erhalten, und wir sind so schnell wie möglich wieder da. Den aktuellen Stand findest du auf unserer Statusseite.`,
    button: 'Statusseite öffnen',
    readonly: 'Änderungen sind zu deinem Schutz wegen Wartungsarbeiten pausiert. Du kannst weiterhin alles ansehen; Bearbeiten ist so schnell wie möglich wieder möglich.',
  },
};

// While the AI features are off (a Jira administrator's switch, or SUPERPORT's stop) the dialog offers no Field
// Assistant: it says why and where to go instead, in the words of the server's refusal (src/settings.js, aibudget.js).
const AI_OFF_TEXT = {
  en: {
    title: 'Field Assistant is turned off',
    off: 'The AI features of this app are turned off. A Jira administrator can turn them on in the app\'s Configuration (Jira settings > Apps > Custom Field Self-Service for Jira).',
    stopped: 'The AI features of this app are temporarily turned off by the app vendor. Please try again later.',
    admin: 'You can add or request the field on the project\'s Custom fields page.',
    other: 'Ask a project admin of {key} for the field.',
  },
  de: {
    title: 'Field Assistant ist ausgeschaltet',
    off: 'Die KI-Funktionen dieser App sind ausgeschaltet. Ein Jira-Admin kann sie in der Konfiguration der App einschalten (Jira-Einstellungen > Apps > Custom Field Self-Service for Jira).',
    stopped: 'Die KI-Funktionen dieser App sind vorübergehend vom App-Anbieter ausgeschaltet. Bitte versuche es später noch einmal.',
    admin: 'Du kannst das Feld auf der Seite „Custom fields“ des Projekts anlegen oder beantragen.',
    other: 'Bitte einen Projekt-Admin von {key} um das Feld.',
  },
};

const App = () => {
  const ctx = useProductContext();
  const [state, setState] = useState(null);
  const [need, setNeed] = useState('');
  const [opened, setOpened] = useState(false);
  const [openError, setOpenError] = useState('');
  // SUPERPORT's kill switch first (decided on the server): while the app is down nothing else is asked.
  const [avail, setAvail] = useState(null);
  useEffect(() => {
    invoke('availability').catch(() => null).then((a) => {
      const known = a && !a.error ? a : { mode: 'off', statusUrl: STATUS_PAGE_URL };
      setAvail(known);
      if (known.mode !== 'on') invoke('issueContext').then(setState);
    });
  }, []);
  const followStatus = () => router.open(avail?.statusUrl || STATUS_PAGE_URL).catch(() => null);
  const lang = /^de/i.test(ctx?.locale || '') ? 'de' : 'en';
  const mt = MAINTENANCE_TEXT[lang];
  if (avail?.mode === 'on') {
    return (
      <Stack space="space.200">
        <SectionMessage appearance="warning" title={mt.title}>
          <Text>{mt.body}</Text>
        </SectionMessage>
        <ButtonGroup>
          <Button onClick={followStatus}>{mt.button}</Button>
          <Button appearance="subtle" onClick={() => view.close()}>Close</Button>
        </ButtonGroup>
      </Stack>
    );
  }
  if (!state || !ctx) return <Spinner label="Loading" />;
  if (state.error) return <SectionMessage appearance="information"><Text>{state.error}</Text></SectionMessage>;
  const p = ctx.extension.project;
  const appId = (ctx.localId || '').split('/')[1];
  const settingsUrl = `/jira/${PATH[p.type] || 'core'}/projects/${p.key}/settings/apps/${appId}/${ctx.environmentId}`;
  if (state.ai?.enabled !== true) {
    const at = AI_OFF_TEXT[lang];
    return (
      <Stack space="space.200">
        <SectionMessage appearance="information" title={at.title}>
          <Text>{state.ai?.stopped ? at.stopped : at.off}</Text>
          <Text>{state.isAdmin ? at.admin : at.other.replace('{key}', p.key)}</Text>
        </SectionMessage>
        <ButtonGroup>
          {state.isAdmin ? <Button appearance="primary" onClick={() => router.navigate(settingsUrl)}>Open Custom fields</Button> : null}
          <Button appearance="subtle" onClick={() => view.close()}>Close</Button>
        </ButtonGroup>
      </Stack>
    );
  }
  const ask = async () => {
    setOpenError('');
    try {
      await rovo.open({ type: 'forge', agentName: 'Field Assistant', agentKey: 'field-assistant', prompt: `Project ${p.key}, work item ${state.issueKey}: ${need || 'I need a new custom field.'}` });
      setOpened(true);
    } catch (e) {
      setOpenError(e.message || 'Rovo chat could not be opened from here.');
    }
  };
  return (
    <Stack space="space.200">
      {avail?.mode === 'readonly' ? (
        <SectionMessage appearance="warning">
          <Text>{mt.readonly}</Text>
        </SectionMessage>
      ) : null}
      {avail?.mode === 'readonly' ? <Button appearance="link" onClick={followStatus}>{mt.button}</Button> : null}
      {!state.isAdmin ? (
        <SectionMessage appearance="information" title="Your project admins decide">
          <Text>{`You are not a project admin of ${p.key}. You can still ask: Field Assistant previews the change and, once you confirm, sends it to ${state.admins.length ? state.admins.join(', ') : 'the project admins'} for approval. You get an e-mail when they decide.`}</Text>
        </SectionMessage>
      ) : null}
      <Label labelFor="need">Which field is missing on {state.issueKey}?</Label>
      <TextArea id="need" placeholder="What should people be able to record, and what are the choices (if any)?" value={need} onChange={(e) => setNeed(e.target.value)} />
      <ButtonGroup>
        <Button appearance="primary" onClick={ask}>Ask Field Assistant</Button>
        {state.isAdmin ? <Button onClick={() => router.navigate(settingsUrl)}>Open Custom fields</Button> : null}
        <Button appearance="subtle" onClick={() => view.close()}>Close</Button>
      </ButtonGroup>
      {opened ? <SectionMessage appearance="success"><Text>Field Assistant is open in the Rovo panel with your request. You can close this dialog.</Text></SectionMessage> : null}
      {openError ? <SectionMessage appearance="warning"><Text>{openError} Open Rovo chat (bottom right), choose Field Assistant and paste: Project {p.key}, work item {state.issueKey}: {need}</Text></SectionMessage> : null}
      <Text size="small">Field Assistant checks for existing fields (also in other languages), shows a preview with the impact and submits only after you confirm.</Text>
    </Stack>
  );
};

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
