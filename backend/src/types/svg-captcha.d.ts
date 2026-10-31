declare module 'svg-captcha' {
  export interface CaptchaOptions {
    size?: number;
    noise?: number;
    color?: boolean;
    background?: string;
    width?: number;
    height?: number;
    fontSize?: number;
    charPreset?: string;
  }

  export interface CaptchaObject {
    data: string;
    text: string;
  }

  export function create(options?: CaptchaOptions): CaptchaObject;

  const svgCaptcha: {
    create: typeof create;
  };

  export default svgCaptcha;
}
