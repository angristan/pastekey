export async function settledMap<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<U>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results: U[] = [];
  const completed: Array<{ index: number; value: U }> = [];
  let nextIndex = 0;
  let failureCount = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        completed.push({ index, value: await map(values[index]!, index) });
      } catch {
        failureCount += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  completed.sort((left, right) => left.index - right.index);
  for (const { value } of completed) results.push(value);
  return { values: results, failureCount };
}
