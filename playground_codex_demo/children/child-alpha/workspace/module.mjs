/**
 * Trie la liste des tâches par priorité décroissante, puis par date d'échéance
 * croissante. Ajoute un rang calculé pour faciliter le reporting.
 * @param {{ items: Array<{ title: string, priority: number, dueDays: number }> }} input
 * @returns {{ items: Array<{ title: string, priority: number, dueDays: number, rank: number }> }}
 */
export function transform(input) {
  if (!input || !Array.isArray(input.items)) {
    throw new TypeError('Expected input.items to be an array of task descriptors.');
  }
  // Duplique les tâches pour éviter toute mutation du tableau source.
  const normalised = input.items.map((task) => ({
    title: String(task.title),
    priority: Number(task.priority),
    dueDays: Number(task.dueDays)
  }));
  // Tri multi-critères : priorité décroissante puis échéance croissante.
  normalised.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.dueDays - b.dueDays;
  });
  return {
    items: normalised.map((task, index) => ({
      ...task,
      rank: index + 1
    }))
  };
}

export default transform;
