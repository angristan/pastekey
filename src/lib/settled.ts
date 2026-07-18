export async function settledValues<T>(promises: Iterable<PromiseLike<T>>) {
  const results = await Promise.allSettled(promises);
  return {
    values: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    failureCount: results.filter((result) => result.status === "rejected").length,
  };
}
