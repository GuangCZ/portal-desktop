import { Fragment } from 'react';
import { mentionParts, type MentionNames } from '../models/mentions';

export function MentionText({ text, names }: { text: string; names: MentionNames }) {
  return <>{mentionParts(text, names).map((part, index) => part.id
    ? <span key={index} className="town-mention" title={'@' + part.id} data-town-id={part.id}>{part.text}</span>
    : <Fragment key={index}>{part.text}</Fragment>)}</>;
}
