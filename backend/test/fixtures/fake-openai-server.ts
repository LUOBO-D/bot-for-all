import { createFakeProviderApp } from './fake-openai';

const app = createFakeProviderApp();
app.listen(4010, () => {
  console.log('fake openai provider listening on http://127.0.0.1:4010');
});
