import { Query, QueryClient } from '@tanstack/react-query';

export const STRICTLY_PUBLIC_QUERY_ROOTS = new Set<string>([
  'homepage-events',
  'events-discover',
  'cities',
]);

export function isVerifiedPublicQuery(query: Query): boolean {
  const rootKey = query.queryKey[0];
  return typeof rootKey === 'string' && STRICTLY_PUBLIC_QUERY_ROOTS.has(rootKey);
}

export function clearAuthenticatedQueries(queryClient: QueryClient | null | undefined): void {
  if (!queryClient) return;
  queryClient.removeQueries({
    predicate: (query) => !isVerifiedPublicQuery(query),
  });
}
