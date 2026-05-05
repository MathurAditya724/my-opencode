// Concurrency cap to prevent a noisy delivery from fanning out into N
// parallel LLM calls.

export type Semaphore = {
  acquire(): Promise<void>
  release(): void
}

export function makeSemaphore(limit: number): Semaphore {
  let inFlight = 0
  const waiters: Array<() => void> = []
  return {
    async acquire() {
      if (inFlight < limit) {
        inFlight++
        return
      }
      await new Promise<void>((r) => waiters.push(r))
      inFlight++
    },
    release() {
      inFlight--
      const n = waiters.shift()
      if (n) n()
    },
  }
}

// In-flight counter for graceful shutdown drain.
export type DrainCounter = {
  start(): void
  end(): void
  /** Resolves when in-flight count hits zero. */
  wait(): Promise<void>
  inFlight(): number
}

export function makeDrainCounter(): DrainCounter {
  let n = 0
  const waiters: Array<() => void> = []
  return {
    start() {
      n++
    },
    end() {
      n--
      if (n === 0) {
        while (waiters.length > 0) waiters.shift()!()
      }
    },
    wait() {
      if (n === 0) return Promise.resolve()
      return new Promise<void>((r) => waiters.push(r))
    },
    inFlight() {
      return n
    },
  }
}
