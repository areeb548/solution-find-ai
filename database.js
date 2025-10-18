import Datastore from 'nedb-promises';

const usersDb = Datastore.create({
  filename: 'data/users.db',
  autoload: true,
});

const questionsDb = Datastore.create({
  filename: 'data/questions.db',
  autoload: true,
});

await usersDb.ensureIndex({ fieldName: 'email', unique: true });
await questionsDb.ensureIndex({ fieldName: 'userId' });
await questionsDb.ensureIndex({ fieldName: 'createdAt' });

export { usersDb, questionsDb };
