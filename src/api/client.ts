/**
 * The only thing the fleet logic needs from the outside world: GET a
 * Kubernetes API path on one Supervisor. Headlamp provides one implementation
 * (headlampClient.ts); tests or a future server-side aggregator provide others.
 */
export interface SupervisorClient {
  get<T = unknown>(path: string): Promise<T>;
}

/** One write to the Supervisor. Actions are short lists of these, applied in order. */
export interface WriteRequest {
  method: 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** For PATCH: application/merge-patch+json or application/json-patch+json. */
  contentType?: string;
}

export interface SupervisorWriter {
  /** With dryRun, the Supervisor validates the change (RBAC, admission webhooks) without applying it. */
  send(req: WriteRequest, dryRun: boolean): Promise<unknown>;
}

export function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function describeError(err: unknown): string {
  const status = statusOf(err);
  if (status === 401) {
    return 'The Supervisor rejected the credentials (401). Sign in again and refresh the kubeconfig.';
  }
  if (status === 403) {
    return 'Access denied (403).';
  }
  const message = err instanceof Error ? err.message : String(err);
  return status ? `${message} (${status})` : message;
}
