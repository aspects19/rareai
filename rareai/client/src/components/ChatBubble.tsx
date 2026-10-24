import React from 'react';
import { cn } from '../utils';

type Role = 'user' | 'assistant';

export type ChatBubbleProps = {
  role: Role;
  firstInGroup?: boolean;
  className?: string;
  children: React.ReactNode;
  skeleton?: boolean;
};

const ChatBubble: React.FC<ChatBubbleProps> = ({ role, firstInGroup, className, children, skeleton }) => {
  return (
    <div
      className={cn(
        'bubble',
        role === 'user' ? 'bubble--user' : 'bubble--assistant',
        skeleton ? 'bubble-skeleton' : '',
        firstInGroup ? 'bubble--first' : '',
        className,
      )}
    >
      {children}
    </div>
  );
};

export default ChatBubble;

