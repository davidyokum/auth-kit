/**
 * Subject rotation (register E3): a tour of every subject before repeats, kept in this browser only;
 * random; the subject of the day; a fixed one. The seed locks the look, never the subject.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { countySurvey } from '../../src/backdrops/styles/county-survey/index.js';
import { riverBasins } from '../../src/backdrops/styles/river-basins/index.js';
import { starChart } from '../../src/backdrops/styles/star-chart/index.js';
import { aurora } from '../../src/backdrops/styles/aurora/index.js';
import { type SubjectEnvironment, pickSubject, resetPickedSubjects } from '../../src/backdrops/subjects.js';

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

function env(storage: Storage | null = memoryStorage(), now = Date.UTC(2026, 9, 19)): SubjectEnvironment {
  let x = 0.37;
  return { storage, random: () => (x = (x * 9301 + 0.49297) % 1), now: () => now };
}

beforeEach(() => resetPickedSubjects());

describe('pickSubject', () => {
  it('tours every basin once before any repeats, one per visit, kept in this browser only', () => {
    const e = env();
    const seen: string[] = [];
    for (let visit = 0; visit < 17; visit++) {
      resetPickedSubjects(); // a new page
      seen.push(pickSubject(riverBasins, 'seed-a', {}, e)!.key);
    }
    expect(new Set(seen).size).toBe(17);
    const stored = [...(e.storage as ReturnType<typeof memoryStorage>).data.keys()];
    expect(stored).toEqual(['auth-kit:backdrop-tour:river-basins:all:seed-a']);
    resetPickedSubjects();
    // The 18th visit starts a new lap.
    expect(riverBasins.subjects!.sets.all).toContain(pickSubject(riverBasins, 'seed-a', {}, e)!.key);
  });

  it('keeps the same subject for the rest of the page (a resize re-creates the backdrop)', () => {
    const e = env();
    const a = pickSubject(countySurvey, 's', {}, e)!;
    expect(pickSubject(countySurvey, 's', {}, e)).toEqual(a);
    expect(a).toMatchObject({ set: 'all', of: 100, rotation: 'tour' });
    expect(a.index).toBe(countySurvey.subjects!.sets.all!.indexOf(a.key) + 1);
  });

  it('falls back to the subject of the day where storage is blocked or throws', () => {
    const blocked = pickSubject(countySurvey, 's', {}, env(null))!;
    expect(blocked.fallback).toBe(true);
    resetPickedSubjects();
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined } as unknown as Storage;
    expect(pickSubject(countySurvey, 's', {}, env(throwing))).toMatchObject({ key: blocked.key, fallback: true });
  });

  it('of the day: the same for everyone that day, another day another; varied by the seed', () => {
    const today = pickSubject(countySurvey, 's', { rotation: 'day' }, env(null, Date.UTC(2026, 9, 19)))!.key;
    expect(pickSubject(countySurvey, 's', { rotation: 'day' }, env(memoryStorage(), Date.UTC(2026, 9, 19, 23)))!.key).toBe(today);
    const days = new Set(Array.from({ length: 10 }, (_, d) => pickSubject(countySurvey, 's', { rotation: 'day' }, env(null, Date.UTC(2026, 9, 19 + d)))!.key));
    expect(days.size).toBeGreaterThan(5);
  });

  it('random and fixed; Star Chart’s two sets (40 by default, all 88)', () => {
    expect(pickSubject(starChart, 's', { rotation: 'fixed', key: 'Cyg' }, env())).toMatchObject({ key: 'Cyg', set: 'curated', of: 40 });
    expect(pickSubject(starChart, 's', { set: 'all', rotation: 'random' }, env())).toMatchObject({ set: 'all', of: 88 });
    expect(starChart.subjects!.sets.curated).toHaveLength(40);
  });

  it('refuses what the style can’t do', () => {
    expect(() => pickSubject(aurora, 's', { rotation: 'day' }, env())).toThrow(/no subjects/);
    expect(pickSubject(aurora, 's', {}, env())).toBeUndefined();
    expect(() => pickSubject(countySurvey, 's', { rotation: 'fixed' }, env())).toThrow(/needs subject.key/);
    expect(() => pickSubject(countySurvey, 's', { rotation: 'fixed', key: 'Atlantis' }, env())).toThrow(/no subject "Atlantis"/);
    expect(() => pickSubject(countySurvey, 's', { rotation: 'weekly' as never }, env())).toThrow(/rotation must be/);
  });
});
