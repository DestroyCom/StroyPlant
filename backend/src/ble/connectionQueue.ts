// Queue de connexion séquentielle pour le Parrot Pot (STROYPLANT_SPEC.md section 7.1) : une seule
// connexion GATT à la fois, que ce soit un poll périodique du scanner ou un trigger manuel via l'API
// — le BLE ne supporte pas bien plusieurs connexions GATT simultanées sur un dongle USB classique.
export class ConnectionQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Le prochain job démarre même si celui-ci échoue — chaque appelant gère sa propre erreur via
    // la promesse retournée par run(), la queue elle-même ne doit jamais rester bloquée.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
