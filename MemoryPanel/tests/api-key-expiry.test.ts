import { describe, expect, it } from 'vitest';

import { isApiKeyExpiryDateDisabled } from '../web/src/pages/ApiKeysPage/components/api-key-expiry.js';

describe('API Key expiry date', () => {
  const now = new Date(2026, 7, 20, 14, 0, 0);
  const dateValue = (year: number, month: number, day: number, hour = 0) => ({
    valueOf: () => new Date(year, month - 1, day, hour, 0, 0).valueOf(),
  });

  it('disables past dates', () => {
    expect(isApiKeyExpiryDateDisabled(dateValue(2026, 8, 19, 23), now)).toBe(true);
  });

  it('allows today and future dates', () => {
    expect(isApiKeyExpiryDateDisabled(dateValue(2026, 8, 20), now)).toBe(false);
    expect(isApiKeyExpiryDateDisabled(dateValue(2026, 9, 1), now)).toBe(false);
  });
});
