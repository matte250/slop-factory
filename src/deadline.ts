/**
 * Race a Promise against a timer that rejects. Returns the resolved value if
 * the work completes in time, otherwise throws Error("<label> exceeded
 * deadline of <ms>ms"). The underlying work is NOT cancelled — callers must
 * arrange their own cleanup (e.g. close the browser) in a finally.
 */
export async function withDeadline<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} exceeded deadline of ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
