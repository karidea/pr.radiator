import { useState, useEffect } from 'react';
import {
  addWeeks,
  addDays,
  addHours,
  isAfter,
  format,
  formatRFC3339,
  formatDistanceToNow,
  parseISO
} from 'date-fns';
import { sortByCreatedAt } from './utils';
import {
  FaCheck,
  FaCommentDots,
  FaExclamationTriangle,
  FaHourglassHalf,
  FaTimes,
  FaMinus,
  FaExclamationCircle
} from 'react-icons/fa';

type Event = {
  createdAt: string;
  author: string;
  state: string;
  count?: number;
}

const combineReviewsAndComments = (reviews: any, comments: any) => {
  const events: Event[] = [];

  reviews.nodes.forEach((review: any) => {
    const state = review.state === 'COMMENTED' ? 'COMMENTED' : review.state;
    events.push({
      createdAt: review.createdAt,
      author: review.author.login,
      state,
    });
  });

  comments.nodes.forEach((comment: any) => {
    events.push({
      createdAt: comment.createdAt,
      author: comment.author.login,
      state: 'COMMENTED',
    });
  });

  const sortedEvents = events.sort(sortByCreatedAt);

  const compressedEvents: Event[] = [];
  if (sortedEvents.length === 0) return compressedEvents;

  let currentEvent: Event = { ...sortedEvents[0], count: 1 };

  for (let i = 1; i < sortedEvents.length; i++) {
    const curr = sortedEvents[i];

    // Group if same author/state (no time check)
    if (curr.author === currentEvent.author && curr.state === currentEvent.state) {
      currentEvent.count = (currentEvent.count || 1) + 1;
    } else {
      compressedEvents.push(currentEvent);
      currentEvent = { ...curr, count: 1 };
    }
  }
  compressedEvents.push(currentEvent);

  return compressedEvents;
};

const getAgeString = (createdAt: Date) => {
  const current = new Date();
  if (isAfter(createdAt, addHours(current, -1))) {
    return 'last-hour';
  } else if (isAfter(createdAt, addHours(current, -2))){
    return 'last-two-hours';
  } else if (isAfter(createdAt, addDays(current, -1))){
    return 'last-day';
  } else if (isAfter(createdAt, addWeeks(current, -1))){
    return 'last-week';
  }
  return 'over-week-old';
}

const getCommitState = (headRefOid: string, commits: any) => {
  const node = commits.nodes.find((node: any) => node.commit.oid === headRefOid);

  const icons: any = {
    'SUCCESS': <FaCheck className="event-icon" />,
    'PENDING': <FaHourglassHalf className="event-icon" />,
    'FAILURE': <FaTimes className="event-icon" />,
    'EXPECTED': <FaHourglassHalf className="event-icon" />,
    'ERROR': <FaExclamationTriangle className="event-icon" />
  };

  const conclusion: any = node?.commit?.statusCheckRollup?.state || 'ERROR';
  const icon = icons[conclusion] || <FaMinus className="event-icon" />;
  const className = conclusion.toLowerCase();

  return <span className={className}>{icon}</span>;
};

const TimelineEvent = (props: Event) => {
  const countBadge = (props.count ?? 1) > 1 ? `(${props.count})` : '';
  const authorWithCount = `${props.author}${countBadge}`;

  const formattedDate = format(parseISO(props.createdAt), 'PPPpp');
  let tooltip = `${authorWithCount} ${props.state.toLowerCase()} at ${formattedDate}`;

  if (props.state === 'APPROVED') {
    return (
      <span className="event-group approved" title={tooltip}>
        {authorWithCount} <FaCheck className="event-icon" />
      </span>
    );
  } else if (props.state === 'CHANGES_REQUESTED') {
    tooltip = `${authorWithCount} requested changes at ${formattedDate}`;
    return (
      <span className="event-group changes-requested" title={tooltip}>
        {authorWithCount} <FaTimes className="event-icon" />
      </span>
    );
  } else if (props.state === 'COMMENTED') {
    tooltip = `${authorWithCount} commented at ${formattedDate}`;
    return (
      <span className="event-group commented" title={tooltip}>
        {authorWithCount} <FaCommentDots className="event-icon" />
      </span>
    );
  } else if (props.state === 'DISMISSED') {
    tooltip = `${authorWithCount} dismissed at ${formattedDate}`;
    return (
      <span className="event-group dismissed" title={tooltip}>
        {authorWithCount} <FaMinus className="event-icon" />
      </span>
    );
  }
  return null;
};

const PR = (props: any) => {
  const { showBranch, pr: { createdAt, reviews, comments, baseRefName, author: { login: author }, headRefOid, url, repository, title, commits }}= props;
  const createdAtDate = new Date(createdAt);

  const [elapsedTimeStr, setElapsedTimeStr] = useState(formatDistanceToNow(createdAtDate, { addSuffix: true, includeSeconds: true }));
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedTimeStr(formatDistanceToNow(createdAtDate, { addSuffix: true, includeSeconds: true }));
    }, 5000);

    return () => clearInterval(interval);
  }, [createdAt]);

  const elapsedTime = <span title={formatRFC3339(createdAtDate)}>{elapsedTimeStr}</span>;
  const events = combineReviewsAndComments(reviews, comments);
  const commitState = getCommitState(headRefOid, commits);
  const reviewState = reviews.nodes.length === 0 && (<FaExclamationCircle className="event-icon unreviewed-icon" title="Unreviewed PR - Needs attention!" />);
  const prLink = <a href={url} target="_blank" rel="noopener noreferrer">{`${repository.name}#${props.pr.number}`}</a>;
  const branch = showBranch ? baseRefName : '';
  const eventOutput = events.length > 0 && (
    <>
      <br />
      &nbsp;&nbsp;{events.map((event, index) => <TimelineEvent key={index} {...event} />)}
    </>
  );

  return (
    <div className={getAgeString(createdAtDate)}>
      {elapsedTime} {reviewState} {commitState} {branch} {author} {prLink} {title}
      {eventOutput}
    </div>
  );
}

export default PR;
