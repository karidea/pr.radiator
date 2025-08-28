export const sortByCreatedAt = (a: any, b: any) => {
  if (a.createdAt < b.createdAt) {
    return -1;
  }
  if (a.createdAt > b.createdAt) {
    return 1;
  }
  return 0;
}

export const byCommittedDateDesc = (a: any, b: any) => {
  if (a.committedDate > b.committedDate) {
    return -1;
  }
  if (a.committedDate < b.committedDate) {
    return 1;
  }
  return 0;
}

const progressBar: HTMLDivElement = document.createElement('div');
progressBar.id = 'progress-bar';
document.body.appendChild(progressBar);

export function startProgress(): void {
  progressBar.classList.add('active');
}

export function stopProgress(): void {
  progressBar.classList.add('fade-out');
  setTimeout(() => {
    progressBar.classList.remove('active', 'fade-out');
  }, 300); // Matches CSS transition duration
}
