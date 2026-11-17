# Vector stores

Every knowledge base stores its embeddings in one vector store, chosen when the knowledge base is created.

| Store                       | Setup                                                       | Limits                                                        | Good for                                                        |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| **Lumen managed** (default) | None                                                        | 768, 1024, 1536 or 3072 dimensions                            | Most tenants; nothing extra to run or pay for                   |
| **Pinecone**                | Your API key and an index                                   | Index dimension must match the embedding model; cosine metric | Tenants who already use Pinecone or need very large collections |
| **Google Firestore**        | A service-account key and a vector index per knowledge base | Up to 2048 dimensions                                         | Tenants already on Firebase/Google Cloud                        |

Lumen always keeps the text of every chunk in its own database, so citations work the same whichever store holds the vectors. Moving a knowledge base to another store later is possible without re-reading the original files.

## Pinecone

1. In the Pinecone console, create a **dense** index with metric **cosine** and the **same dimension** as your embedding model, as shown on Lumen's Models page. For example, `text-embedding-3-small` at 1536 needs an index of dimension 1536.
2. Create an API key.
3. In Lumen, go to **Knowledge**, then **New knowledge base**, then **Use your own Pinecone or Firestore**, and enter the key and index name. Lumen checks that the index exists, that its dimension matches, and that it uses cosine, before saving.

Each knowledge base uses its own **namespace** (`kb_<id>`) inside the index, so one index can serve many knowledge bases. Deleting a knowledge base deletes its namespace.

## Google Firestore

1. In Google Cloud, create a service account with the **Cloud Datastore User** role and download a JSON key.
2. In Lumen, add the key under **Use your own Pinecone or Firestore**, then **Firestore**. Lumen checks that it can reach the project.
3. Create the knowledge base. Firestore needs a **vector index per knowledge base** before it can be searched. The first search, or the error on a document, shows the exact command, for example:

   ```bash
   gcloud firestore indexes composite create --project=YOUR_PROJECT --collection-group=lumen_kb_<id> \
     --query-scope=COLLECTION --field-config=order=ASCENDING,field-path=audience \
     --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
   ```

   Index creation takes a few minutes. Documents can be uploaded in the meantime.

Each knowledge base is stored in its own collection (`lumen_kb_<id>`). Each item holds `embedding`, `documentId` and `audience`.

## Audiences

Each document is uploaded as **Everyone** (`public`) or **Staff only** (`staff`). Every store filters searches by audience, so staff-only content never reaches public visitors. Lumen also re-checks the audience against its own database before returning results.
