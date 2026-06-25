import { describe, expect, it } from 'vitest';

import {
  isPreapprovedHost,
  isPreapprovedUrl,
} from '../../../src/tools/builtin/web/preapproved-hosts';

describe('isPreapprovedHost', () => {
  it('docs.python.org is preapproved', () => {
    expect(isPreapprovedHost('docs.python.org', '/')).toBe(true);
  });

  it('github.com/moonshot/tools is preapproved (path-prefix)', () => {
    expect(isPreapprovedHost('github.com', '/moonshot/tools')).toBe(true);
  });

  it('github.com/evil/malware is NOT preapproved (boundary check)', () => {
    expect(isPreapprovedHost('github.com', '/evil/malware')).toBe(false);
  });

  it('random-site.com is NOT preapproved', () => {
    expect(isPreapprovedHost('random-site.com', '/')).toBe(false);
  });
});

describe('isPreapprovedUrl', () => {
  it('returns true for a preapproved URL', () => {
    expect(isPreapprovedUrl('https://docs.python.org/3/library/os.html')).toBe(true);
  });

  it('returns false for a non-preapproved URL', () => {
    expect(isPreapprovedUrl('https://evil.example.com/')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isPreapprovedUrl('not-a-valid-url')).toBe(false);
  });
});
