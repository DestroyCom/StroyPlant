// Sequential connection queue for the Parrot Pot (docs/STROYPLANT_SPEC.md section 7.1): only one
// GATT connection at a time, whether it's a periodic scanner poll or a manual trigger via the API
// — BLE doesn't handle multiple simultaneous GATT connections well on a typical USB dongle.
export class ConnectionQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // The next job starts even if this one fails — each caller handles its own error via
    // the promise returned by run(), the queue itself must never stay blocked.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
