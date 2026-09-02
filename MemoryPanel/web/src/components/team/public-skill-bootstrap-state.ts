export function shouldRefreshBindingsAfterBootstrap(
  previousStatus: string,
  nextStatus: string,
): boolean {
  return (
    ['pending', 'running'].includes(previousStatus) && ['completed', 'partial'].includes(nextStatus)
  );
}
