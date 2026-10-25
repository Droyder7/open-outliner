import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
afterEach(() => vi.unstubAllEnvs());
describe('optional attachment configuration', () => {
  it('keeps the text-only default and indefinite trash', () => {
    vi.stubEnv('S3_ENDPOINT', '');
    vi.stubEnv('AUTOMATIC_GC', '');
    expect(loadConfig().s3Endpoint).toBeUndefined();
    expect(loadConfig().automaticGc).toBe(false);
  });
  it('fails explicitly for a partially configured object store', () => {
    vi.stubEnv('S3_ENDPOINT', 'https://objects.example.test');
    vi.stubEnv('S3_ACCESS_KEY_ID', '');
    vi.stubEnv('S3_SECRET_ACCESS_KEY', '');
    expect(() => loadConfig()).toThrow('requires S3_ACCESS_KEY_ID');
  });
});
