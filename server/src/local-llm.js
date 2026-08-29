import os from 'os';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const MODELS_DIR = path.join(os.homedir(), '.gemini', 'models');

const MODELS = {
  'qwen': {
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'
  },
  'llama': {
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf'
  }
};

export class LocalLLM {
  constructor() {
    this.llama = null;
    this.activeModelId = null;
    this.model = null;
    this.context = null;
    this.isLoading = false;
  }

  async downloadModel(modelId, onProgress) {
    if (!fs.existsSync(MODELS_DIR)) {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
    }
    
    const modelInfo = MODELS[modelId] || MODELS['qwen'];
    const destPath = path.join(MODELS_DIR, modelInfo.file);
    
    if (fs.existsSync(destPath)) {
      return destPath;
    }
    
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      
      const request = (url) => {
        https.get(url, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            return request(response.headers.location);
          }
          
          if (response.statusCode !== 200) {
            fs.unlinkSync(destPath);
            return reject(new Error(`Failed to download model: ${response.statusCode}`));
          }
          
          const totalBytes = parseInt(response.headers['content-length'], 10);
          let downloadedBytes = 0;
          let lastReported = 0;
          
          response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const now = Date.now();
            if (onProgress && now - lastReported > 500) {
              const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
              const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
              const percent = Math.round((downloadedBytes / totalBytes) * 100);
              onProgress(`Downloading ${modelInfo.file}... ${percent}% (${mb}/${totalMb} MB)`);
              lastReported = now;
            }
          });
          
          response.pipe(file);
          
          file.on('finish', () => {
            file.close();
            resolve(destPath);
          });
        }).on('error', (err) => {
          fs.unlinkSync(destPath);
          reject(err);
        });
      };
      
      request(modelInfo.url);
    });
  }

  async loadModel(modelId, onProgress) {
    if (this.model && this.activeModelId === modelId) return;
    
    if (this.isLoading) {
      while(this.isLoading) {
        await new Promise(r => setTimeout(r, 500));
      }
      if (this.activeModelId === modelId) return;
    }
    
    this.isLoading = true;
    try {
      if (onProgress) onProgress(`Checking for ${modelId} model...`);
      const modelPath = await this.downloadModel(modelId, onProgress);
      
      if (onProgress) onProgress(`Initializing Metal GPU backend for ${modelId}...`);
      if (!this.llama) {
        this.llama = await getLlama();
      }
      
      if (this.model) {
        // Dispose old model if switching
        if (this.context) await this.context.dispose();
        if (this.model) await this.model.dispose();
      }
      
      this.model = await this.llama.loadModel({ modelPath });
      this.context = await this.model.createContext();
      this.activeModelId = modelId;
    } catch (e) {
      console.error('Failed to load local model:', e);
      throw e;
    } finally {
      this.isLoading = false;
    }
  }

  async generate(prompt, modelId = 'qwen', onProgress) {
    await this.loadModel(modelId, onProgress);
    
    if (onProgress) onProgress(`Generating response using ${modelId}...`);
    
    const session = new LlamaChatSession({
      contextSequence: this.context.getSequence()
    });
    
    const response = await session.prompt(prompt);
    
    return response;
  }
}
