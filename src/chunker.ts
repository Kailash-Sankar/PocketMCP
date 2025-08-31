export interface TextChunk {
  text: string;
  startOffset: number;
  endOffset: number;
  index: number;
}

export interface ChunkerOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export class TextChunker {
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(options: ChunkerOptions) {
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
  }

  chunkText(text: string): TextChunk[] {
    if (!text.trim()) {
      return [];
    }

    // First try sentence-based chunking
    const sentenceChunks = this.chunkBySentences(text);
    
    // If sentence-based chunking produces reasonable results, use it
    if (this.isGoodChunking(sentenceChunks)) {
      return sentenceChunks;
    }

    // Fall back to sliding window chunking
    return this.chunkBySlidingWindow(text);
  }

  private chunkBySentences(text: string): TextChunk[] {
    const sentences = this.splitIntoSentences(text);
    const chunks: TextChunk[] = [];
    let currentChunk = '';
    let currentStart = 0;
    let chunkIndex = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const potentialChunk = currentChunk + (currentChunk ? ' ' : '') + sentence.text;

      if (potentialChunk.length <= this.chunkSize || currentChunk === '') {
        // Add sentence to current chunk
        if (currentChunk === '') {
          currentStart = sentence.start;
        }
        currentChunk = potentialChunk;
      } else {
        // Current chunk is full, save it and start new one
        if (currentChunk) {
          chunks.push({
            text: currentChunk.trim(),
            startOffset: currentStart,
            endOffset: currentStart + currentChunk.length,
            index: chunkIndex++
          });
        }

        // Start new chunk with overlap
        const overlapText = this.getOverlapText(currentChunk, this.chunkOverlap);
        currentChunk = overlapText + (overlapText ? ' ' : '') + sentence.text;
        currentStart = sentence.start - overlapText.length - (overlapText ? 1 : 0);
      }
    }

    // Add final chunk if it has content
    if (currentChunk.trim()) {
      chunks.push({
        text: currentChunk.trim(),
        startOffset: currentStart,
        endOffset: currentStart + currentChunk.length,
        index: chunkIndex
      });
    }

    return chunks;
  }

  private chunkBySlidingWindow(text: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    let start = 0;
    let chunkIndex = 0;

    while (start < text.length) {
      const end = Math.min(start + this.chunkSize, text.length);
      let chunkText = text.substring(start, end);

      // Try to break at word boundaries if we're not at the end
      if (end < text.length) {
        const lastSpace = chunkText.lastIndexOf(' ');
        const lastNewline = chunkText.lastIndexOf('\n');
        const breakPoint = Math.max(lastSpace, lastNewline);
        
        if (breakPoint > start + this.chunkSize * 0.7) {
          // Good break point found
          chunkText = chunkText.substring(0, breakPoint);
        }
      }

      chunks.push({
        text: chunkText.trim(),
        startOffset: start,
        endOffset: start + chunkText.length,
        index: chunkIndex++
      });

      // Move start position with overlap consideration
      const nextStart = start + chunkText.length - this.chunkOverlap;
      start = Math.max(nextStart, start + 1); // Ensure progress

      // Break if we're not making meaningful progress
      if (start >= text.length) {
        break;
      }
    }

    return chunks.filter(chunk => chunk.text.length > 0);
  }

  private splitIntoSentences(text: string): Array<{ text: string; start: number; end: number }> {
    const sentences: Array<{ text: string; start: number; end: number }> = [];
    
    // Simple sentence splitting regex - looks for sentence endings followed by space and capital letter
    // or end of string
    const sentenceRegex = /[.!?]+(?:\s+(?=[A-Z])|$)/g;
    let lastIndex = 0;
    let match;

    while ((match = sentenceRegex.exec(text)) !== null) {
      const sentence = text.substring(lastIndex, match.index + match[0].length).trim();
      if (sentence.length > 0) {
        sentences.push({
          text: sentence,
          start: lastIndex,
          end: match.index + match[0].length
        });
      }
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text as a sentence if it exists
    if (lastIndex < text.length) {
      const remainingText = text.substring(lastIndex).trim();
      if (remainingText.length > 0) {
        sentences.push({
          text: remainingText,
          start: lastIndex,
          end: text.length
        });
      }
    }

    return sentences;
  }

  private isGoodChunking(chunks: TextChunk[]): boolean {
    if (chunks.length === 0) return false;
    
    // Check if most chunks are reasonably sized
    const reasonablySized = chunks.filter(chunk => 
      chunk.text.length >= this.chunkSize * 0.3 && 
      chunk.text.length <= this.chunkSize * 1.5
    );
    
    return reasonablySized.length / chunks.length >= 0.7;
  }

  private getOverlapText(text: string, overlapSize: number): string {
    if (text.length <= overlapSize) {
      return text;
    }

    const overlapText = text.substring(text.length - overlapSize);
    
    // Try to start overlap at word boundary
    const spaceIndex = overlapText.indexOf(' ');
    if (spaceIndex > 0 && spaceIndex < overlapSize * 0.5) {
      return overlapText.substring(spaceIndex + 1);
    }
    
    return overlapText;
  }

  // Utility methods
  getChunkSize(): number {
    return this.chunkSize;
  }

  getChunkOverlap(): number {
    return this.chunkOverlap;
  }

  setChunkSize(size: number): void {
    this.chunkSize = size;
  }

  setChunkOverlap(overlap: number): void {
    this.chunkOverlap = overlap;
  }
}
