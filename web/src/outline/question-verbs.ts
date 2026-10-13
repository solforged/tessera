export const questionVerbs: Record<string, string> = {
  'Make recurrent': 'Keeps a current reading without resolving the question.',
  'Allow resolution': 'An accepted reading answers the question.',
  Park: 'Stops coming back until resumed.',
  Resume: 'Returns to its previous active state.',
  'Write assessment': 'Adds a dated assessment; nothing is accepted yet.',
  'Accept current reading': 'Makes this assessment current; keeps earlier readings.',
  'Withdraw current reading': 'Leaves no current reading; keeps every assessment.',
  'Add branch question': 'Adds a question whose parent comes from its place.',
};
