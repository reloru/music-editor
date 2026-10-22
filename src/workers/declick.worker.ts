/// <reference lib="webworker" />
/**
 * One slice of a `declick` run, off the main thread.
 *
 * Declick's autoregressive fit is the slowest thing the editor does, and its
 * windows are independent apart from a short overlap-add warm-up that each task
 * carries for itself. Running slices in several of these at once is what makes
 * Clean stem finish in a fraction of the time on a multi-core phone.
 */
import { runDeclickTask, type DeclickTask, type DeclickTaskResult } from '../audio/effects';

export interface DeclickWorkerRequest {
  task: DeclickTask;
}

export type DeclickWorkerResponse = { type: 'done'; result: DeclickTaskResult } | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<DeclickWorkerRequest>) => {
  try {
    const result = runDeclickTask(event.data.task);
    const response: DeclickWorkerResponse = { type: 'done', result };
    scope.postMessage(response, [result.samples.buffer]);
  } catch (error) {
    const response: DeclickWorkerResponse = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(response);
  }
};
