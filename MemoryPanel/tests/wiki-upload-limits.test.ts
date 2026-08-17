import { describe, expect, it } from 'vitest';

import { resolveWikiUploadLimits } from '../src/panel/config/panel-config.js';
import {
  partitionWikiUploadFiles,
  utf8ByteLength,
  WIKI_UPLOAD_MAX_FILE_BYTES,
} from '../web/src/pages/wiki/WikiPage/components/wiki-constants.js';

describe('Wiki upload limits', () => {
  it('defaults to a 10 MiB file and a bounded 50 MiB request', () => {
    expect(resolveWikiUploadLimits({})).toEqual({
      maxFileBytes: 10 * 1024 * 1024,
      maxFilesPerRequest: 10,
      maxTotalBytes: 50 * 1024 * 1024,
    });
  });

  it('accepts environment overrides and ignores invalid values', () => {
    expect(resolveWikiUploadLimits({
      CBRAIN_WIKI_UPLOAD_MAX_FILE_BYTES: '20971520',
      CBRAIN_WIKI_UPLOAD_MAX_FILES: '4',
      CBRAIN_WIKI_UPLOAD_MAX_TOTAL_BYTES: '-1',
    })).toEqual({
      maxFileBytes: 20 * 1024 * 1024,
      maxFilesPerRequest: 4,
      maxTotalBytes: 50 * 1024 * 1024,
    });
  });

  it('rejects oversized or unsupported browser files before upload', () => {
    const accepted = new File(['ok'], 'ok.md');
    const oversized = new File([new Uint8Array(WIKI_UPLOAD_MAX_FILE_BYTES + 1)], 'large.md');
    const unsupported = new File(['no'], 'image.png');
    expect(partitionWikiUploadFiles([accepted, oversized, unsupported])).toEqual({
      accepted: [accepted],
      unsupportedCount: 1,
      oversizedCount: 1,
    });
    expect(utf8ByteLength('你好')).toBe(6);
  });
});
