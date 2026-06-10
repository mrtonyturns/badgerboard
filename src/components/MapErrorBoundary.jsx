import React from 'react'
import { Map } from 'lucide-react'

export default class MapErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.warn('Map error caught by boundary:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full bg-gray-50 rounded-xl text-center p-8">
          <Map className="w-10 h-10 text-gray-300 mb-3" />
          <p className="text-gray-500 font-semibold">Map failed to load</p>
          <p className="text-gray-400 text-sm mt-1">Try switching back to table view and then map view again.</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-4 text-sm text-brand-red hover:underline"
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
