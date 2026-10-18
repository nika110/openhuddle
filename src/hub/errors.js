export class HubError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code, message) => new HubError(400, code, message);
export const forbidden = (code, message) => new HubError(403, code, message);
export const notFound = (code, message) => new HubError(404, code, message);
export const conflict = (code, message) => new HubError(409, code, message);
