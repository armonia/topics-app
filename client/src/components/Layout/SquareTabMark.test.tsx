/**
 * A TAB SQUEEZED TO ITS FACE STILL SHOWS ITS SUBJECT AT WORK (TABSLOT-02).
 *
 * At 375 and 768 px the unselected tabs shrink to a face (the topic's initial,
 * or the icon of a terminal, a browser, a project) and have no slot, so a
 * subject at work drew no loader at all. The loader now takes the place of the
 * face inside a box of the SAME footprint, so the tab does not change width
 * when the work starts or ends. The box is what these tests read: the real
 * layout (bounding boxes) is for the e2e suite, here the two states must hand
 * the tab the same reserved box, and the loader the same geometry as the
 * normal tab's. One case per kind, all through the one component.
 *
 * @covers TABSLOT-02
 */
import { test, expect, beforeEach } from 'bun:test';
import type { ReactElement } from 'react';
import { mount, type HostNode } from '../../test/reactHarness';
import { signalsActions, useSignalsStore } from '../../state/signals';
import { attentionActions, useAttentionStore } from '../../state/attention';
import { TopicsProvider } from '../../contexts/TopicsContext';
import { SquareTabMark, TopicInitial, type SquareLoaderSource } from './SquareTabMark';
import {
  TopicStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner, ProjectStreamingSpinner,
} from './StreamingIndicator';
import type { Topic, TerminalSessionInfo } from '../../types';

// The harness renders on the server, which reads zustand's initial state: point it at the live one.
(useSignalsStore as unknown as { getInitialState: unknown }).getInitialState = useSignalsStore.getState;
(useAttentionStore as unknown as { getInitialState: unknown }).getInitialState = useAttentionStore.getState;

const topic = { id: 't1', name: 'Revisione', projectPath: '/p' } as unknown as Topic;
const term = { id: 'S', type: 'claude-code', name: 'agent', cwd: '/p', createdAt: '2026-10-03T10:00:00.000Z' } as unknown as TerminalSessionInfo;

interface Kind {
  name: string;
  source: SquareLoaderSource;
  /** The face the real tab draws at rest, with the footprint PaneTabBar gives it. */
  face: ReactElement;
  /** The footprint of that face, as the classes the box carries. */
  box: string[];
  /** The normal tab's spinner of the same subject. */
  spinner: ReactElement;
  work: () => void;
}

const kinds: Kind[] = [
  {
    name: 'topic', source: { kind: 'topic', topicId: 't1' },
    face: <TopicInitial color="#22c55e" label="Revisione" />, box: ['flex-shrink-0', 'h-5', 'w-5'],
    spinner: <TopicStreamingSpinner topicId="t1" />,
    work: () => signalsActions.setLiveStreamTopics(new Set(['t1'])),
  },
  {
    name: 'terminal', source: { kind: 'terminal', sessionId: 'S' },
    face: <span data-face className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0" />, box: ['flex-shrink-0', 'h-3.5', 'w-3.5'],
    spinner: <TerminalStreamingSpinner sessionId="S" />,
    work: () => signalsActions.setTerminalBusy('S', true),
  },
  {
    name: 'browser', source: { kind: 'browser', paneId: 'browser:b1' },
    face: <span data-face className="relative flex items-center justify-center w-4 h-4 flex-shrink-0" />, box: ['flex-shrink-0', 'h-4', 'w-4'],
    spinner: <BrowserStreamingSpinner paneId="browser:b1" />,
    work: () => signalsActions.setBrowserBusy('browser:b1', true),
  },
  {
    name: 'project', source: { kind: 'project', path: '/p' },
    face: <span data-face className="relative flex items-center justify-center w-3.5 h-3.5 flex-shrink-0" />, box: ['flex-shrink-0', 'h-3.5', 'w-3.5'],
    spinner: <ProjectStreamingSpinner projectPath="/p" />,
    work: () => signalsActions.setLiveStreamTopics(new Set(['t1'])),
  },
];

beforeEach(() => {
  attentionActions.reset();
  signalsActions.setLiveStreamTopics(new Set());
  signalsActions.setTerminalBusy('S', false);
  signalsActions.setBrowserBusy('browser:b1', false);
});

function hostsOf(el: ReactElement): HostNode[] {
  const h = mount(<TopicsProvider topics={{ t1: topic }} terminalSessions={[term]}>{el}</TopicsProvider>);
  const hosts = h.last().hosts;
  h.unmount();
  return hosts;
}

const mark = (k: Kind) => hostsOf(<SquareTabMark source={k.source}>{k.face}</SquareTabMark>);
const hasFace = (hosts: HostNode[]) => hosts.some((n) => 'data-face' in n.props || 'data-topic-initial' in n.props);
const hasLoader = (hosts: HostNode[]) => hosts.some((n) => 'data-loader-state' in n.props);
const classesOf = (node: HostNode) => String(node.props.className).split(/\s+/).filter((c) => /^(h|w)-|^flex-shrink-0$/.test(c)).sort();
const loaderStyle = (hosts: HostNode[]) => hosts.find((n) => 'data-loader-state' in n.props)!.props.style as { width: number; height: number };

for (const k of kinds) {
  test(`${k.name}: at rest the squeezed tab draws its face, no loader`, () => {
    const hosts = mark(k);
    expect(hasFace(hosts)).toBe(true);
    expect(hasLoader(hosts)).toBe(false);
  });

  test(`${k.name}: at work the loader takes the face's place, in a box of the same footprint`, () => {
    const rest = mark(k);
    k.work();
    const work = mark(k);
    expect(hasLoader(work)).toBe(true);
    expect(hasFace(work)).toBe(false);
    // The reserved box is the face's own, so the tab keeps its width either way.
    const box = work.find((n) => n.props['data-testid'] === 'square-tab-loader')!;
    expect(classesOf(box)).toEqual(k.box);
    expect(classesOf(rest[0]!)).toEqual(k.box);
  });

  test(`${k.name}: the loader is the normal tab's, same 16 px geometry`, () => {
    k.work();
    expect(loaderStyle(mark(k))).toEqual(loaderStyle(hostsOf(k.spinner)));
    expect(loaderStyle(mark(k)).width).toBe(16);
  });
}

test('another subject at work does not light this tab', () => {
  signalsActions.setLiveStreamTopics(new Set(['other']));
  expect(hasLoader(mark(kinds[0]!))).toBe(false);
});

test('with no source the face is drawn untouched, whatever works', () => {
  signalsActions.setLiveStreamTopics(new Set(['t1']));
  const hosts = hostsOf(<SquareTabMark source={null}>{kinds[0]!.face}</SquareTabMark>);
  expect(hasFace(hosts)).toBe(true);
  expect(hasLoader(hosts)).toBe(false);
});
