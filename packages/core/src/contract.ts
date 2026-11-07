/** The acceptance contract every workspace starts with. */
export const defaultContract = {
  id: 'default',
  version: 'default-v1',
  title: 'Default acceptance contract',
  criteria: [
    {
      id: 'approved-checks',
      title: 'Every approved check has fresh passing evidence',
      required: true,
    },
  ],
};
