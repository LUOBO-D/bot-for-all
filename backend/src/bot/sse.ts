export class SseParser {
  private buffer = '';

  feed(chunk: string): string[] {
    this.buffer += chunk;
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    const events: string[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const dataLines: string[] = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (dataLines.length > 0) {
        events.push(dataLines.join('\n'));
      }
      boundary = this.buffer.indexOf('\n\n');
    }
    return events;
  }
}
