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
