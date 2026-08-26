import { Readable } from 'node:stream';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';

export interface StoredBrochure { bytes:Buffer;sizeBytes:number;mediaType:'application/pdf' }
export interface ContestBrochureStore {
  put(tenant:string,brochureId:string,bytes:Buffer):Promise<{objectKey:string;sizeBytes:number}>;
  get(objectKey:string):Promise<StoredBrochure|undefined>;
  delete(objectKey:string):Promise<void>;
}

export class MemoryContestBrochureStore implements ContestBrochureStore {
  private readonly objects=new Map<string,Buffer>();
  async put(tenant:string,brochureId:string,bytes:Buffer){const objectKey=`${tenant}/${brochureId}.pdf`;this.objects.set(objectKey,Buffer.from(bytes));return{objectKey,sizeBytes:bytes.length};}
  async get(objectKey:string){const bytes=this.objects.get(objectKey);return bytes?{bytes:Buffer.from(bytes),sizeBytes:bytes.length,mediaType:'application/pdf' as const}:undefined;}
  async delete(objectKey:string){this.objects.delete(objectKey);}
}

class AzureContestBrochureStore implements ContestBrochureStore {
  private readonly container;
  constructor(){
    const account=process.env.CONTEST_BROCHURE_AZURE_ACCOUNT;const key=process.env.CONTEST_BROCHURE_AZURE_KEY;const container=process.env.CONTEST_BROCHURE_AZURE_CONTAINER;
    if(!account||!key||!container)throw new Error('Azure contest brochure storage is not fully configured');
    const service=new BlobServiceClient(`https://${account}.blob.core.windows.net`,new StorageSharedKeyCredential(account,key));this.container=service.getContainerClient(container);
  }
  async put(tenant:string,brochureId:string,bytes:Buffer){const objectKey=`${tenant}/${brochureId}.pdf`;const blob=this.container.getBlockBlobClient(objectKey);await blob.uploadData(bytes,{blobHTTPHeaders:{blobContentType:'application/pdf'}});return{objectKey,sizeBytes:bytes.length};}
  async get(objectKey:string){const response=await this.container.getBlobClient(objectKey).download();if(!response.readableStreamBody)return undefined;const chunks:Buffer[]=[];for await(const chunk of response.readableStreamBody as Readable)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);return{bytes,sizeBytes:bytes.length,mediaType:'application/pdf' as const};}
  async delete(objectKey:string){await this.container.getBlobClient(objectKey).deleteIfExists();}
}

export function createContestBrochureStore():ContestBrochureStore {
  const mode=process.env.CONTEST_BROCHURE_STORAGE??(process.env.NODE_ENV==='production'?'azure':'memory');
  if(mode==='memory')return new MemoryContestBrochureStore();
  if(mode==='azure')return new AzureContestBrochureStore();
  throw new Error(`Unsupported CONTEST_BROCHURE_STORAGE=${mode}`);
}