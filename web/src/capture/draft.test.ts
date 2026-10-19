import { describe, expect, test } from 'bun:test';
import { capturePresentation, editCaptureDraft } from './draft';

const essay = '#[[01ARZ3NDEKTSV4RRFFQ69G5FAV|essay]]';
const language = '#[[01ARZ3NDEKTSV4RRFFQ69G5FAW|Italian word]]';

describe('readable capture tags', () => {
  test('hides canonical IDs while retaining chosen identities', () => {
    const source = `Phone note ${essay} `;
    expect(capturePresentation(source).text).toBe('Phone note #essay ');
    expect(editCaptureDraft(source, 'Phone note #essay ')).toBe(source);
    expect(editCaptureDraft(source, 'New Phone note #essay ')).toBe(`New Phone note ${essay} `);
    expect(editCaptureDraft(source, 'Phone note #essay next')).toBe(`${source}next`);
  });
  test('editing or extending a tag name discards its old identity', () => {
    expect(editCaptureDraft(`${essay} `, '#essays ')).toBe('#essays ');
    expect(editCaptureDraft(`${essay} `, '#essa ')).toBe('#essa ');
    expect(editCaptureDraft(essay, '#essays')).toBe('#essays');
    expect(editCaptureDraft(`${essay} `, 'plain text')).toBe('plain text');
  });
  test('retains multiple tags and multiword spellings across prose edits', () => {
    const source = `Read ${essay} and ${language} `;
    expect(capturePresentation(source).text).toBe('Read #essay and #[[Italian word]] ');
    expect(editCaptureDraft(source, 'Study #essay and #[[Italian word]] ')).toBe(`Study ${essay} and ${language} `);
    expect(editCaptureDraft(source, 'Read #essays and #[[Italian word]] ')).toBe(`Read #essays and ${language} `);
  });
  test('completion inserts canonical tags without changing earlier choices', () => {
    expect(editCaptureDraft(`${essay} #It`, `#essay ${language} `)).toBe(`${essay} ${language} `);
  });
  test('leaves protected syntax alone', () => {
    const source = `\`${essay}\` ${essay}`;
    expect(capturePresentation(source).text).toBe(`\`${essay}\` #essay`);
  });
});
