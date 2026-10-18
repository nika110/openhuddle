import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, crew } from './helpers/hubcore.js';
import { HubError } from '../src/hub/errors.js';
import { PROMPT_SECTIONS } from '../src/shared/protocol.js';

const section = (prompt, title) => prompt.sections.find((s) => s.title === title);

test('prompt: new team has template sections', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  const p = hub.getPrompt(auth(0).team_id);
  assert.deepEqual(p.sections.map((s) => s.title), PROMPT_SECTIONS);
  assert.equal(p.state, 'draft');
  assert.equal(p.version, 0);
});

test('prompt: edits to different sections both survive', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.promptEdit(auth(0), { section: 'idea', text: 'A pizza ordering app' });
  const { prompt } = hub.promptEdit(auth(1), { section: 'Tech stack', text: 'Next.js + Postgres' });
  assert.equal(section(prompt, 'Idea').body, 'A pizza ordering app');
  assert.equal(section(prompt, 'Tech stack').body, 'Next.js + Postgres');
  assert.equal(section(prompt, 'Idea').updated_by, auth(0).id);
  assert.equal(prompt.version, 2);
});

test('prompt: append mode appends with newline, new titles add sections', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  hub.promptEdit(auth(0), { section: 'Must-haves', text: '- login' });
  hub.promptEdit(auth(0), { section: 'Must-haves', text: '- cart', mode: 'append' });
  const { prompt } = hub.promptEdit(auth(0), { section: 'Pricing', text: 'free' });
  assert.equal(section(prompt, 'Must-haves').body, '- login\n- cart');
  assert.equal(prompt.sections.at(-1).title, 'Pricing');
});

test('prompt: submit then all approve locks v1', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben', 'cy']);
  hub.promptEdit(auth(0), { section: 'Idea', text: 'pizza' });
  let { prompt } = hub.promptSubmit(auth(0));
  assert.equal(prompt.state, 'voting');
  assert.equal(prompt.needed, 3);
  hub.promptVote(auth(1), { approve: true });
  ({ prompt } = hub.promptVote(auth(2), { approve: true }));
  assert.equal(prompt.state, 'locked');
  assert.equal(prompt.locked_version, 1);
  const kinds = hub.events(auth(0), { since: 0 }).events.map((e) => e.kind);
  assert.deepEqual(kinds.slice(-4), ['prompt_submitted', 'prompt_vote', 'prompt_vote', 'prompt_locked']);
});

test('prompt: one reject under all keeps voting', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben', 'cy']);
  hub.promptEdit(auth(0), { section: 'Idea', text: 'pizza' });
  hub.promptSubmit(auth(0));
  hub.promptVote(auth(1), { approve: false, comment: 'needs payments' });
  const { prompt } = hub.promptVote(auth(2), { approve: true });
  assert.equal(prompt.state, 'voting');
  assert.deepEqual(prompt.votes[auth(1).id], { approve: false, comment: 'needs payments' });
});

test('prompt: majority rule locks with 2 of 3', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben', 'cy']);
  hub.settings(auth(0), { approvals: { master_prompt: 'majority' } });
  hub.promptEdit(auth(0), { section: 'Idea', text: 'pizza' });
  hub.promptSubmit(auth(0));
  const { prompt } = hub.promptVote(auth(1), { approve: true });
  assert.equal(prompt.state, 'locked');
});

test('prompt: solo team locks on submit', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana']);
  hub.promptEdit(auth(0), { section: 'Idea', text: 'pizza' });
  assert.equal(hub.promptSubmit(auth(0)).prompt.state, 'locked');
});

test('prompt: edit while voting resets votes to draft', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.promptEdit(auth(0), { section: 'Idea', text: 'pizza' });
  hub.promptSubmit(auth(0));
  const { prompt } = hub.promptEdit(auth(1), { section: 'Idea', text: 'pizza + delivery' });
  assert.equal(prompt.state, 'draft');
  assert.deepEqual(prompt.votes, {});
});

test('prompt: edit after lock → amending with locked_sections kept', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  hub.promptEdit(auth(0), { section: 'Idea', text: 'pizza' });
  hub.promptSubmit(auth(0));
  hub.promptVote(auth(1), { approve: true });
  let { prompt } = hub.promptEdit(auth(1), { section: 'Idea', text: 'pizza + drinks' });
  assert.equal(prompt.state, 'amending');
  assert.equal(section({ sections: prompt.locked_sections }, 'Idea').body, 'pizza');
  assert.equal(section(prompt, 'Idea').body, 'pizza + drinks');
  hub.promptSubmit(auth(1));
  ({ prompt } = hub.promptVote(auth(0), { approve: true }));
  assert.equal(prompt.state, 'locked');
  assert.equal(prompt.locked_version, 2);
});

test('prompt: vote outside voting → 409 not_voting', () => {
  const { hub } = makeHub();
  const { auth } = crew(hub, ['ana', 'ben']);
  assert.throws(
    () => hub.promptVote(auth(1), { approve: true }),
    (err) => err instanceof HubError && err.status === 409 && err.code === 'not_voting',
  );
  assert.throws(
    () => hub.promptSubmit(auth(0)),
    (err) => err instanceof HubError && err.code === 'empty_prompt',
  );
});
