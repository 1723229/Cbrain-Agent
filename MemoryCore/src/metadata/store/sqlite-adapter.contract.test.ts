import { runMetadataStoreContract } from './metadata-store.contract.js';
import { SqliteMetadataStore } from './sqlite-adapter.js';

runMetadataStoreContract(
  'SQLite',
  async () => new SqliteMetadataStore(':memory:'),
  async (store) => { (store as SqliteMetadataStore).close(); },
);
