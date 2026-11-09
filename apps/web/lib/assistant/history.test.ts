import { describe, expect, it } from 'vitest';
import { fitHistory, HISTORY_CHAR_BUDGET } from './history';

const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });

describe('fitHistory', () => {
  it('keeps a short conversation as it is', () => {
    const messages = [user('How do I invite someone?'), assistant('Open Members.'), user('Then?')];

    expect(fitHistory(messages)).toEqual(messages);
  });

  it('drops the oldest turns once the conversation is over its share of the context', () => {
    const long = 'x'.repeat(Math.ceil(HISTORY_CHAR_BUDGET * 0.4));
    const messages = [
      user(`1 ${long}`),
      assistant(`2 ${long}`),
      user(`3 ${long}`),
      assistant('4'),
      user('5'),
    ];

    expect(fitHistory(messages).map(({ content }) => content[0])).toEqual(['3', '4', '5']);
  });

  it('always keeps the message to answer, however long it is', () => {
    const question = user('x'.repeat(HISTORY_CHAR_BUDGET + 1));

    expect(fitHistory([user('earlier'), assistant('answer'), question])).toEqual([question]);
  });

  it("starts with one of the user's messages, as chat models expect", () => {
    const messages = [
      assistant('Open Members.'),
      user('Then?'),
      assistant('Send it.'),
      user('Ok?'),
    ];

    expect(fitHistory(messages)).toEqual(messages.slice(1));
  });
});
