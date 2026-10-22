/**
 * A short-lived pool of Web Workers that runs `declick` tasks in parallel.
 *
 * Workers are started when a run begins and terminated when it ends, so an
 * idle editor holds no extra threads or memory. Tasks are built just before
 * they are sent, which keeps the copy of the audio each one needs to a few
 * slices at a time instead of a second copy of the whole track.
 */
import type { DeclickExecutor, DeclickTaskResult, DeclickTaskSpec } from './effects';
import type { DeclickWorkerRequest, DeclickWorkerResponse } from '../workers/declick.worker';

/**
 * Phones report fewer cores than desktops and run the efficiency ones slowly;
 * past four, the extra workers mostly add memory pressure and thermal load.
 */
const MAX_WORKERS = 4;

export function createDeclickPool(): DeclickExecutor | null {
  if (typeof Worker === 'undefined') return null;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  const size = Math.min(MAX_WORKERS, cores || 2);
  if (size < 2) return null;

  return {
    size,
    run(specs, onTaskDone) {
      return new Promise<DeclickTaskResult[]>((resolve, reject) => {
        const results = new Array<DeclickTaskResult>(specs.length);
        const workers: Worker[] = [];
        let next = 0;
        let finished = 0;
        let settled = false;

        const stop = (): void => {
          for (const worker of workers) worker.terminate();
        };
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          stop();
          reject(error);
        };

        const dispatch = (worker: Worker): void => {
          if (next >= specs.length) return;
          const index = next++;
          const spec: DeclickTaskSpec = specs[index];
          worker.onmessage = (event: MessageEvent<DeclickWorkerResponse>) => {
            const message = event.data;
            if (message.type === 'error') {
              fail(new Error(message.message));
              return;
            }
            results[index] = message.result;
            onTaskDone(spec);
            if (++finished === specs.length) {
              settled = true;
              stop();
              resolve(results);
            } else {
              dispatch(worker);
            }
          };
          const task = spec.build();
          const request: DeclickWorkerRequest = { task };
          worker.postMessage(request, [task.samples.buffer]);
        };

        try {
          const count = Math.min(size, specs.length);
          for (let i = 0; i < count; i++) {
            const worker = new Worker(new URL('../workers/declick.worker.ts', import.meta.url), { type: 'module' });
            worker.onerror = (event) => fail(new Error(event.message || 'Declick worker failed to start'));
            workers.push(worker);
          }
          for (const worker of workers) dispatch(worker);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}
