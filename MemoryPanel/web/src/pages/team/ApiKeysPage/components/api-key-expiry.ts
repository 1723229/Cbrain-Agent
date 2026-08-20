/** API Key 只能选择今天或未来日期作为失效时间；过去日期不可选。 */
export function isApiKeyExpiryDateDisabled(
  date: { valueOf(): number },
  now: Date = new Date(),
): boolean {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  return date.valueOf() < todayStart.valueOf();
}
