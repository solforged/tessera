export const questionVerbs: Record<string, string> = {
  'Make recurrent': 'Keeps a current answer without resolving the question.',
  'Allow resolution': 'An accepted answer resolves the question.',
  Park: 'Stops coming back until resumed.',
  Resume: 'Returns to its previous active state.',
  'Write assessment': 'Adds a dated assessment; nothing is accepted yet.',
  'Accept current answer': 'Makes this assessment current; keeps earlier answers.',
  'Withdraw current answer': 'Leaves no current answer; keeps every assessment.',
  'Add branch question': 'Adds a question whose parent comes from its place.',
};

export const questionDescriptions: Record<string, string> = {
  ...questionVerbs,
  'Make question': 'Marks this atom as an active question.',
  'Make assessment': 'Dates this atom as an assessment without accepting it.',
  'Set revisit date…': 'Sets the date this question comes back.',
  'Set parent question…': 'Names this question’s parent.',
  'Remove parent': 'Clears the named parent; its place supplies any parent.',
  'Remove question': 'Removes question state and its decision journal, not its text.',
  'Remove assessment': 'Removes its date and assessment state, not its text; clears its acceptance.',
};
